import type { Config } from "../config/config.types.ts";
import type { MqttValue } from "../sharedTypes.ts";

/**
 * The pure core of the overheat sell stop: no IO, no clock reads, no solid — the selftest drives it.
 * useOverheatSellStop.ts feeds it the live reading; shouldSellPower masks the sell export with it.
 */

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

/**
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
    ? reading.value < input.start_selling_again_below_inverter_temp_celsius
    : reading.value >= input.only_sell_below_inverter_temp_celsius;
  if (!crossedLimit) return previousState;
  return { sellingStopped: !previousState.sellingStopped, flipReading: { value: reading.value, time: reading.time } };
}
