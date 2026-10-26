import type { Accessor } from "solid-js";
import type { Config } from "../config/config.types.ts";
import type { MqttValue } from "../sharedTypes.ts";

/**
 * The pure core of the overheat sell stop: no IO, no clock reads, no reactivity — the selftest
 * drives it. useOverheatSellStop.ts feeds it the live reading; shouldSellPower masks the sell
 * export with it.
 *
 * Stop at ≥ only_sell_below, resume at < start_selling_again_below, hold in between. Returns the
 * previous state object itself whenever nothing flips: the memo around this re-runs on every GS
 * round, and identity is what keeps those re-runs from reaching the inverter command effects.
 */
export function stepOverheatSellStop(
  input: OverheatSellStopLimits & {
    previousState: OverheatSellStopState;
    reading: MqttValue | undefined;
    nowMs: number;
  }
): OverheatSellStopState {
  const { previousState, reading } = input;
  if (!reading || input.nowMs - reading.time > MAX_TEMPERATURE_READING_AGE_MS) return previousState;
  const crossedLimit = previousState.sellingStopped
    ? reading.value < effectiveResumeBelowCelsius(input)
    : reading.value >= input.only_sell_below_inverter_temp_celsius;
  if (!crossedLimit) return previousState;
  return { sellingStopped: !previousState.sellingStopped, flipReading: { value: reading.value, time: reading.time } };
}

/**
 * Where selling actually resumes. A misordered pair (no whole-degree reading between resume and
 * stop limit, see overheatLimitsMisordered) has no hysteresis, and the stop moves the reading itself: cutting 14 kW cools the inverter a degree, resuming heats
 * it back, so even a zero-width band bang-bangs 14 kW and pages a P1 per cycle. Such a pair falls
 * back to the default pair's gap below the stop limit; useOverheatSellStop errorLogs it. A retired
 * inverter_temp_p1_celsius ≤ 90 seeded as the stop limit lands here too.
 */
export function effectiveResumeBelowCelsius(limits: OverheatSellStopLimits): number {
  return overheatLimitsMisordered(limits)
    ? limits.only_sell_below_inverter_temp_celsius - MISORDERED_LIMITS_FALLBACK_GAP_CELSIUS
    : limits.start_selling_again_below_inverter_temp_celsius;
}

/**
 * True when no reading would hold the state between the two limits. component_max_temperature is
 * whole °C (an INT field in pi17FieldTables), so 97/96.5 stops at 97 and resumes at 96 with nothing
 * in between, and flaps exactly like a swapped pair. 97/96 keeps its one-reading band.
 */
export function overheatLimitsMisordered(limits: OverheatSellStopLimits): boolean {
  return (
    Math.ceil(limits.start_selling_again_below_inverter_temp_celsius) >= limits.only_sell_below_inverter_temp_celsius
  );
}

/** The default pair's gap (97 → 90 °C) */
export const MISORDERED_LIMITS_FALLBACK_GAP_CELSIUS = 7;

/**
 * component_max_temperature arrives with every GS round, seconds apart. A reading older than this
 * means the serial session is stuck (the mqtt-stale P2 owns that failure), and a stuck value must
 * neither start nor end a stop.
 */
export const MAX_TEMPERATURE_READING_AGE_MS = 2 * 60_000;

export type OverheatSellStopState = {
  sellingStopped: boolean;
  /**
   * The reading that last flipped sellingStopped, absent until the first flip. A plain copy: the
   * inverter telemetry store updates its entries in place, so holding the store's object would
   * quote today's temperature instead of the one that crossed the limit.
   */
  flipReading?: MqttValue;
};

/** Boot assumes not overheated, so a restart inside the 90–97 °C gap sells until the next ≥97 °C reading */
export const OVERHEAT_SELL_STOP_BOOT_STATE: OverheatSellStopState = { sellingStopped: false };

export type OverheatSellStopLimits = Pick<
  Config["scheduled_power_selling"],
  "only_sell_below_inverter_temp_celsius" | "start_selling_again_below_inverter_temp_celsius"
>;

/** What shouldSellPower hands the alerting: the stop itself, and what it is holding back */
export type OverheatSellStopSignals = {
  state: Accessor<OverheatSellStopState>;
  /** Watts scheduled selling would export right now if the stop weren't in force (0 while it isn't) */
  withheldSellWatts: Accessor<number>;
};
