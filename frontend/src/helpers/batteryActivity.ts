import { type Accessor, createMemo } from "solid-js";

export type BatteryActivity = {
  state: "charging" | "discharging" | "idle" | "unknown";
  /** Battery power net of the inverter's idle draw (positive = charging), like the old index page computed. */
  netWatts: number | undefined;
  /** Projected moment the battery is full (charging) / empty (discharging) at the current rate. */
  etaMs: number | undefined;
};

/** Below this the reading is noise, not a real charge/discharge — show "idle" instead of a 400-day ETA. */
const IDLE_BAND_WATTS = 25;

/**
 * Charge/discharge state + a full/empty ETA, derived entirely from the Ah ledger now that the Wh energy
 * counters are gone. The Wh headroom to the relevant rail is (SOC-distance) × capacity_ah × branch voltage:
 * charging counts up to full at v_charge, discharging down to empty at v_discharge.
 */
export function useBatteryActivity(inputs: {
  batteryPowerWatts: Accessor<number | undefined>;
  /** Inverter idle draw in watts (drain_a × v_discharge from the synced config). */
  idleWatts: Accessor<number | undefined>;
  /** Ah-ledger SOC in percent, clamped to [0,100] (the `averageSOC` ws value). */
  socPercent: Accessor<number | undefined>;
  /** Usable pack capacity in amp-hours (config soc_calculations.ah_ledger.capacity_ah). */
  capacityAh: Accessor<number | undefined>;
  /** Mean charge-branch terminal voltage (config ah_ledger.v_charge). */
  vCharge: Accessor<number | undefined>;
  /** Mean discharge-branch terminal voltage (config ah_ledger.v_discharge). */
  vDischarge: Accessor<number | undefined>;
}): Accessor<BatteryActivity> {
  return createMemo<BatteryActivity>(() => {
    const batteryPower = inputs.batteryPowerWatts();
    if (batteryPower === undefined) return { state: "unknown", netWatts: undefined, etaMs: undefined };
    const netWatts = batteryPower - (inputs.idleWatts() || 0);
    if (Math.abs(netWatts) < IDLE_BAND_WATTS) return { state: "idle", netWatts, etaMs: undefined };

    const socPercent = inputs.socPercent();
    const capacityAh = inputs.capacityAh();
    const branchVoltage = netWatts > 0 ? inputs.vCharge() : inputs.vDischarge();
    let whLeft: number | undefined;
    if (socPercent !== undefined && capacityAh !== undefined && branchVoltage !== undefined) {
      const socHeadroomFraction = netWatts > 0 ? (100 - socPercent) / 100 : socPercent / 100;
      whLeft = socHeadroomFraction * capacityAh * branchVoltage;
    }
    const etaMs = whLeft === undefined ? undefined : Date.now() + (whLeft / Math.abs(netWatts)) * 3600_000;
    return { state: netWatts > 0 ? "charging" : "discharging", netWatts, etaMs };
  });
}
