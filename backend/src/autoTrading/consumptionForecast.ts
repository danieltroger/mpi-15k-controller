import Influx from "influx";
import { errorLog, logLog, warnLog } from "../utilities/logging.ts";

export type ConsumptionForecast = {
  /** Expected house load (AC output) in watts at a given time, excluding inverter parasitic draw */
  wattsAt: (ms: number) => number;
  source: "influx" | "fallback";
  fetchedAtMs: number;
  profile: number[];
};

/** Constants for stripping water-heater consumption out of the learned history (see below) */
export type ElpatronHistoryKnobs = {
  element_watts: number;
  tank_wh_per_degree: number;
  tank_cooling_degrees_per_hour: number;
  tank_max_temperature: number;
};

let cache: (ConsumptionForecast & { elpatronKey: string }) | undefined;

function localHour(ms: number): number {
  return parseInt(
    new Date(ms).toLocaleString("sv-SE", { timeZone: "Europe/Stockholm", hour: "2-digit", hourCycle: "h23" }),
    10
  );
}

/**
 * Learn the house's typical consumption per local hour-of-day from the last 14 days of inverter data.
 * Median over days is used so that rare heavy loads (EV charging sessions) don't inflate the baseline —
 * those are exactly what the user handles manually via the extra-reserve knob.
 *
 * The water heater element's share is stripped from each historical hour using the tank sensor
 * (see estimateElpatronWattsByHour) — the forward model adds the element back whenever it's
 * armed, so leaving it in the baseline would double-count it, and element days linger in this
 * 14-day window after disarming. The subtraction runs unconditionally: it self-gates per hour by
 * detecting boiler-heated hours from the tank data itself, so stove season degrades to a no-op.
 */
export async function fetchConsumptionForecast(
  influxClient: Influx.InfluxDB | undefined,
  fallbackWatts: number,
  subtractElpatron?: ElpatronHistoryKnobs
): Promise<ConsumptionForecast> {
  const maxAgeMs = 12 * 3600 * 1000;
  // Key the cache on the knob values too, so recalibrating them doesn't serve a stale profile
  const elpatronKey = JSON.stringify(subtractElpatron ?? null);
  if (
    cache &&
    Date.now() - cache.fetchedAtMs < maxAgeMs &&
    cache.source === "influx" &&
    cache.elpatronKey === elpatronKey
  ) {
    return cache;
  }

  let profile: number[] | undefined;
  if (influxClient) {
    try {
      // The influx client has no timeout of its own — don't let a hung connection stall callers forever
      const withTimeout = <T>(promise: Promise<T>) =>
        Promise.race([
          promise,
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("InfluxDB query timed out")), 45_000)),
        ]);
      const rows = (await withTimeout(
        influxClient.query(
          `SELECT mean(ac_output_total_active_power) as house FROM "mpp-solar" WHERE time > now() - 14d GROUP BY time(1h)`
        )
      )) as unknown as { time: { getNanoTime(): number }; house: number | null }[];

      const elpatronWByHourMs = subtractElpatron
        ? await estimateElpatronHistory(influxClient, subtractElpatron, withTimeout)
        : undefined;

      const byHour: number[][] = Array.from({ length: 24 }, () => []);
      let hoursWithTankData = 0;
      for (const row of rows) {
        if (row.house == null) continue;
        const ms = Math.round(row.time.getNanoTime() / 1e6);
        const elpatronW = elpatronWByHourMs?.get(ms);
        if (elpatronW !== undefined) hoursWithTankData++;
        // When the element dominates the hour (a burn, or night top-ups over a small base), the
        // residual is unmeasurable — drop the sample instead of feeding a fake 0 into the median
        if (elpatronW !== undefined && elpatronW > row.house * 0.9) continue;
        byHour[localHour(ms)].push(row.house - (elpatronW ?? 0));
      }
      if (elpatronWByHourMs && hoursWithTankData === 0) {
        // The subtraction silently doing nothing would double-count the element: it stays in this
        // learned baseline AND gets added by the forward model. Over-provisions the reserve
        // (the safe direction), but must be loud so a dead tank sensor gets noticed.
        warnLog(
          "Elpatron history subtraction found no usable tank data — learned baseline still contains the element and the forward model adds it again (over-forecast until the akkumulator sensor is back)"
        );
      }
      if (byHour.some(bucket => bucket.length >= 3)) {
        profile = byHour.map(bucket => {
          if (!bucket.length) return fallbackWatts;
          const sorted = [...bucket].sort((a, b) => a - b);
          return sorted[Math.floor(sorted.length / 2)];
        });
        logLog(
          `Learned consumption profile (W by local hour${subtractElpatron ? ", elpatron share removed" : ""}):`,
          profile.map(w => Math.round(w)).join(",")
        );
      }
    } catch (e) {
      errorLog("Failed to learn consumption profile from InfluxDB, using fallback", e);
    }
  }

  const finalProfile = profile ?? new Array(24).fill(fallbackWatts);
  cache = {
    wattsAt: ms => finalProfile[localHour(ms)],
    source: profile ? "influx" : "fallback",
    fetchedAtMs: Date.now(),
    profile: finalProfile,
    elpatronKey,
  };
  return cache;
}

async function estimateElpatronHistory(
  influxClient: Influx.InfluxDB,
  knobs: ElpatronHistoryKnobs,
  withTimeout: <T>(promise: Promise<T>) => Promise<T>
): Promise<Map<number, number>> {
  const rows = (await withTimeout(
    influxClient.query(
      `SELECT mean(akkumulator) as tank FROM "frendebo_thermometers" WHERE time > now() - 14d GROUP BY time(1h)`
    )
  )) as unknown as { time: { getNanoTime(): number }; tank: number | null }[];
  const tankByMs = new Map<number, number>();
  for (const row of rows) {
    if (row.tank == null) continue;
    tankByMs.set(Math.round(row.time.getNanoTime() / 1e6), row.tank);
  }
  return estimateElpatronWattsByHour(tankByMs, knobs);
}

/**
 * Estimate the element's average watts for each historical hour from the tank sensor: energy in ≈
 * tank_wh_per_degree × (temperature rise + what standing loss ate). Hot-water usage hours show a
 * steep temperature DROP and clamp to 0; hours holding the thermostat band land near the standing
 * loss — both are what actually happened electrically, to within the calibration.
 *
 * The element is NOT assumed to be the only heat source — the pellet boiler is detected and its
 * hours excluded via a physics fingerprint on the same data: the element's thermostat cuts around
 * tank_max_temperature (observed maxima ≤ ~56 °C) and it can't heat the sensor faster than
 * ~12 °C/h, while boiler firings push to 62–70 °C at 8–19 °C/h (measured 2026-06-16..18). Any
 * sample above tank_max + 2 marks its ±6 h neighbourhood as boiler-heated (firings rise through
 * the element's band on the way up and coast back down through it for hours), and an
 * implausibly-fast rise is excluded on its own. In deep stove season the daily firings blanket
 * the whole window, so the subtraction self-disables without any signal from the heating pi —
 * its stove GPIO turned out to be a call-for-heat line (asserted all summer) and its
 * stove_disabled config flag flips with operator fiddling, so neither is trusted here.
 *
 * Residual risks, for the record: a PARTIAL firing that never crests tank_max + 2 and rises
 * ≤15 °C/h would be subtracted as element — the one misclassification that UNDER-forecasts
 * (all others over-forecast, the safe direction). Real firings reach 62–70 °C, so this is the
 * tail case. And tank_max_temperature does double duty as the element band edge (−5) and the
 * boiler ceiling (+2): recalibrating it moves both, which at worst mislabels element burns as
 * boiler (safe direction, element stays in the baseline).
 *
 * Pure and exported for the selftest.
 */
export function estimateElpatronWattsByHour(
  tankByMs: Map<number, number>,
  knobs: ElpatronHistoryKnobs
): Map<number, number> {
  const hourMs = 3600 * 1000;
  const boilerTemperatureC = knobs.tank_max_temperature + 2;
  const maxElementRiseDegreesPerHour = 15;
  const boilerNeighbourhoodHours = 6;

  const boilerContaminatedMs = new Set<number>();
  for (const [ms, tank] of tankByMs) {
    if (tank <= boilerTemperatureC) continue;
    for (let offset = -boilerNeighbourhoodHours; offset <= boilerNeighbourhoodHours; offset++) {
      boilerContaminatedMs.add(ms + offset * hourMs);
    }
  }

  const elpatronWByMs = new Map<number, number>();
  for (const [ms, tank] of tankByMs) {
    const nextTank = tankByMs.get(ms + hourMs);
    if (nextTank === undefined) continue;
    const deltaDegrees = nextTank - tank;
    const boilerHeated = boilerContaminatedMs.has(ms) || deltaDegrees > maxElementRiseDegreesPerHour;
    // The standing-loss term only belongs to hours the element could have been compensating it:
    // a rising tank, or a flat one held near the thermostat band. A tank coasting well below the
    // band cools slower than the (hot-tank-calibrated) constant, and crediting the difference to
    // the element invented a few hundred phantom watts on quiet nights — enough to out-dominate
    // a small house load and get real samples dropped.
    const elementCouldBeActive = !boilerHeated && (deltaDegrees > 0 || tank >= knobs.tank_max_temperature - 5);
    const estimatedW = elementCouldBeActive
      ? knobs.tank_wh_per_degree * (deltaDegrees + knobs.tank_cooling_degrees_per_hour)
      : 0;
    elpatronWByMs.set(ms, Math.min(knobs.element_watts, Math.max(0, estimatedW)));
  }
  return elpatronWByMs;
}
