import type { MqttValue } from "../sharedTypes.ts";

/**
 * How old the inverter's grid power reading may be for a plan to start a running sell window from it
 * (PlannerInput.measuredFeedInW). GS rounds arrive ~50×/min, so an older reading means telemetry has
 * stalled and the planner replays the ramp over the schedule instead. At the modelled ~1.5 kW/min a
 * reading this old lags the real feed by at most ~0.75 kW, which costs the simulation a few Wh.
 */
export const MEASURED_FEED_IN_MAX_AGE_MS = 30_000;

/**
 * The grid export the inverter measured (W, ≥ 0) from its ac_input_total_active_power reading, which is
 * negative while feeding. undefined when there is no reading, it isn't a finite number, or it is older
 * than MEASURED_FEED_IN_MAX_AGE_MS at nowMs.
 */
export function freshMeasuredFeedInW(gridPower: MqttValue | undefined, nowMs: number): number | undefined {
  if (!gridPower || !Number.isFinite(gridPower.value) || !Number.isFinite(gridPower.time)) return undefined;
  if (nowMs - gridPower.time > MEASURED_FEED_IN_MAX_AGE_MS) return undefined;
  return Math.max(0, -gridPower.value);
}
