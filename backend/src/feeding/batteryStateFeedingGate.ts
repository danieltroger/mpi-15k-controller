import type { Config } from "../config/config.types.ts";

/**
 * How long a fresh feeding loop waits for `charging` before it stops feeding from the battery. On a normal
 * boot the first battery voltage (GS) decodes a few seconds before the BATS readback and the SOC that
 * `charging` needs; going straight to "not feeding" would write EDF0/EDG0 on every start and then sit out
 * the 3-min change throttle before the real decision. A minute covers that while bounding how long the
 * inverter's persisted feed settings outlive a power cut.
 */
export const CHARGING_UNKNOWN_GRACE_MS = 60_000;

export type BatteryStateGate =
  /** The battery state settles the decision (undefined = make none yet, write nothing). */
  | { settled: true; decision: boolean | undefined; reason: string }
  /** Both known and nothing to veto: the rest of feedWhenNoSolar's logic decides. */
  | { settled: false; batteryVoltage: number; charging: boolean };

/**
 * The battery-state checks heading feedWhenNoSolar's should-feed-from-the-battery decision. Pure, so
 * feedingWhileSocUnknown.selftest.ts can walk a power cut that lands mid-sell.
 *
 * `charging` (the float workaround's isCharging) is unknown exactly while the SOC is, and after a power
 * cycle that lasts until InfluxDB answers (battery/socAnchorRestore.ts). Holding the previous decision
 * there would leave the inverter on whatever feed settings it persisted: after a power cut mid-sell that
 * is sell power, past the window's end and past every SOC/voltage limit. So, as buying falls back to EDB0,
 * an unknown `charging` with nothing decided yet falls back to not feeding from the battery (EDF0/EDG0,
 * max feed-in power back to the solar baseline) once the grace above has passed.
 *
 * A decision that already exists holds through an unknown `charging` instead: the SOC also blinks
 * undefined for a tick whenever the ledger re-anchors, and flipping on that would cost the 3-min throttle.
 * The voltage cutoff needs nothing but the voltage, so it runs first and protects every case.
 */
export function batteryStateFeedingGate({
  batteryVoltage,
  charging,
  previousDecision,
  msSinceFeedingStarted,
  disable_below_battery_voltage,
}: {
  batteryVoltage: number | undefined;
  charging: boolean | undefined;
  previousDecision: boolean | undefined;
  msSinceFeedingStarted: number;
} & Pick<Config["feed_from_battery_when_no_solar"], "disable_below_battery_voltage">): BatteryStateGate {
  if (batteryVoltage === undefined) {
    return { settled: true, decision: previousDecision, reason: "battery voltage unknown" };
  }
  if (batteryVoltage <= disable_below_battery_voltage) {
    return {
      settled: true,
      decision: false,
      reason: `battery voltage ${batteryVoltage}v is below disable threshold ${disable_below_battery_voltage}v`,
    };
  }
  if (charging !== undefined) return { settled: false, batteryVoltage, charging };
  if (previousDecision !== undefined) {
    return { settled: true, decision: previousDecision, reason: "charging unknown, holding the previous decision" };
  }
  if (msSinceFeedingStarted < CHARGING_UNKNOWN_GRACE_MS) {
    return { settled: true, decision: undefined, reason: "charging unknown, waiting for the SOC and BATS readback" };
  }
  return {
    settled: true,
    decision: false,
    reason: "charging still unknown (no SOC yet), not feeding from the battery until it is",
  };
}
