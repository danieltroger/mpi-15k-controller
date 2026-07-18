/**
 * Expected water-heater ("elpatron") load for the planner. The element isn't statistically
 * forecastable — WE switch it (elpatronSwitching.ts gates it by solar for the morning showers of
 * airbnb guests, or someone turns the GPIO on by hand) — so instead of learning it from history,
 * this simulates the controller's own switching rule plus a small tank thermal model forward:
 * a ~6 kW burn from first light until the tank thermostat cuts at ~50 °C, then duty-cycled
 * top-ups covering the standing loss while heating stays allowed.
 *
 * Applies only while the element is armed (solar switching enabled in this project, or the GPIO
 * currently on). In stove season both are off and this contributes nothing — the pellet stove's
 * tank heating must not be attributed to the element.
 */

import Influx from "influx";
import { warnLog } from "../utilities/logging.ts";
import { readHeatingGpio } from "../utilities/heatingPi.ts";
import { resolveElpatronMode } from "../sharedTypes.ts";
import type { Config } from "../config/config.types.ts";

export type ElpatronForecast = {
  /** Expected element draw in watts at a given time; 0 whenever not armed */
  wattsAt: (ms: number) => number;
  armed: boolean;
  tankTempC: number | undefined;
  /**
   * Whether the pellet stove output is on (undefined = heating pi unreachable). While the stove
   * is definitely off, the element is the tank's only heat source — which is what licenses the
   * consumption history subtraction regardless of the element's current armed state.
   */
  stoveOn: boolean | undefined;
};

/**
 * A manually-switched-on element (mode off, GPIO on by hand) is a point-in-time observation, not
 * a policy: extrapolating it as permanent projected ~11 kWh/day of phantom thermostat top-ups for
 * the whole horizon (the 2026-07-16/17 over-forecast + guard churn). Model it for one day ahead —
 * the 15-min guard re-plans keep rolling that window forward for as long as it actually stays on.
 * Exported for the selftest so a changed horizon is tested, not a stale copy.
 */
export const MANUAL_ON_MODEL_HORIZON_MS = 24 * 3600 * 1000;

/**
 * Whether the learned-baseline subtraction may run (see consumptionForecast.ts): while the pellet
 * stove is definitely off, the element is the tank's only heat source, so its historical share is
 * strippable regardless of the element's CURRENT armed state — element days linger in the 14-day
 * median after disarming. Unknown stove state (heating pi unreachable) falls back to the armed
 * gate, which is safe in both seasons. One helper so the planner and planPreview cannot drift.
 */
export function shouldSubtractElpatronHistory(elpatron: Pick<ElpatronForecast, "armed" | "stoveOn">): boolean {
  return elpatron.stoveOn === false || (elpatron.stoveOn === undefined && elpatron.armed);
}

export async function fetchElpatronForecast({
  elpatronConfig,
  influxClient,
  solarWattsAt,
  nowMs,
}: {
  elpatronConfig: Config["elpatron_switching"];
  influxClient: Influx.InfluxDB | undefined;
  solarWattsAt: (ms: number) => number;
  nowMs: number;
}): Promise<ElpatronForecast> {
  // Always read the gpio: even with a switching mode active (armed either way), the stove state
  // decides whether the history subtraction may run
  const gpio = await readHeatingGpio(elpatronConfig.heating_pi_ip);
  const elpatronMode = resolveElpatronMode(elpatronConfig);
  const armed = elpatronMode !== "off" || gpio?.elementOn === true;
  if (!armed) return { wattsAt: () => 0, armed: false, tankTempC: undefined, stoveOn: gpio?.stoveOn };

  const tankTempC = await fetchTankTemperature(influxClient);
  // Without a tank reading, assume mid-band: still predicts a plausible dawn burn + top-ups
  const startTempC = tankTempC ?? elpatronConfig.tank_max_temperature - 5;
  const heatingAllowedAt =
    elpatronMode === "solar"
      ? (ms: number) => solarWattsAt(ms) > elpatronConfig.min_solar_input
      : elpatronMode === "always_on"
        ? () => true
        : // Armed only via the hand-switched GPIO — see MANUAL_ON_MODEL_HORIZON_MS
          (ms: number) => ms - nowMs < MANUAL_ON_MODEL_HORIZON_MS;
  const wattsAt = buildElpatronLoadModel({
    nowMs,
    startTempC,
    heatingAllowedAt,
    element_watts: elpatronConfig.element_watts,
    tank_wh_per_degree: elpatronConfig.tank_wh_per_degree,
    tank_cooling_degrees_per_hour: elpatronConfig.tank_cooling_degrees_per_hour,
    tank_max_temperature: elpatronConfig.tank_max_temperature,
  });
  return { wattsAt, armed: true, tankTempC, stoveOn: gpio?.stoveOn };
}

/**
 * Pure forward simulation of tank temperature vs the switching rule, 15-min steps over 3 days
 * (past the planner's price horizon + constraint tail). Exported for the selftest.
 */
export function buildElpatronLoadModel({
  nowMs,
  startTempC,
  heatingAllowedAt,
  element_watts,
  tank_wh_per_degree,
  tank_cooling_degrees_per_hour,
  tank_max_temperature,
}: {
  nowMs: number;
  startTempC: number;
  heatingAllowedAt: (ms: number) => boolean;
  element_watts: number;
  tank_wh_per_degree: number;
  tank_cooling_degrees_per_hour: number;
  tank_max_temperature: number;
}): (ms: number) => number {
  const stepMs = 15 * 60 * 1000;
  const stepHours = 0.25;
  const steps = 3 * 24 * 4;
  const roomTempC = 20;
  // While the thermostat holds the band, the element duty-cycles at just the standing loss
  const standingLossW = tank_wh_per_degree * tank_cooling_degrees_per_hour;
  const watts = new Array<number>(steps);
  let tempC = startTempC;
  for (let step = 0; step < steps; step++) {
    const midMs = nowMs + step * stepMs + stepMs / 2;
    if (heatingAllowedAt(midMs) && tempC < tank_max_temperature) {
      watts[step] = element_watts;
      tempC = Math.min(
        tank_max_temperature,
        tempC + ((element_watts - standingLossW) / tank_wh_per_degree) * stepHours
      );
    } else if (heatingAllowedAt(midMs)) {
      watts[step] = standingLossW;
    } else {
      watts[step] = 0;
      tempC = Math.max(roomTempC, tempC - tank_cooling_degrees_per_hour * stepHours);
    }
  }
  return ms => {
    const step = Math.floor((ms - nowMs) / stepMs);
    return step >= 0 && step < steps ? watts[step] : 0;
  };
}

async function fetchTankTemperature(influxClient: Influx.InfluxDB | undefined): Promise<number | undefined> {
  if (!influxClient) return undefined;
  try {
    const rows = (await Promise.race([
      influxClient.query(`SELECT last(akkumulator) as tank FROM "frendebo_thermometers" WHERE time > now() - 2h`),
      new Promise((_, reject) => setTimeout(() => reject(new Error("tank temperature query timed out")), 15_000)),
    ])) as unknown as { tank: number | null }[];
    const tank = rows[0]?.tank;
    if (tank == null) {
      warnLog("Elpatron forecast: no recent tank temperature in InfluxDB — assuming mid-band");
      return undefined;
    }
    return tank;
  } catch (e) {
    warnLog("Elpatron forecast: tank temperature query failed — assuming mid-band", e);
    return undefined;
  }
}
