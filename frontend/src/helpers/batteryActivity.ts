import { type Accessor, createMemo } from "solid-js";

export type BatteryActivity = {
  state: "charging" | "discharging" | "idle" | "unknown";
  /** Battery power net of the inverter's parasitic draw (positive = charging), like the old index page computed. */
  netWatts: number | undefined;
  /** Projected moment the battery is full (charging) / empty (discharging) at the current rate. */
  etaMs: number | undefined;
};

/** Below this the reading is noise, not a real charge/discharge — show "idle" instead of a 400-day ETA. */
const IDLE_BAND_WATTS = 25;

export function useBatteryActivity(inputs: {
  batteryPowerWatts: Accessor<number | undefined>;
  parasiticWatts: Accessor<number | undefined>;
  /** energyRemovedSinceFull — Wh of room left before the battery is full again */
  whUntilFull: Accessor<number | undefined>;
  /** energyAddedSinceEmpty — Wh left before the battery is empty again */
  whUntilEmpty: Accessor<number | undefined>;
}): Accessor<BatteryActivity> {
  return createMemo<BatteryActivity>(() => {
    const batteryPower = inputs.batteryPowerWatts();
    if (batteryPower === undefined) return { state: "unknown", netWatts: undefined, etaMs: undefined };
    const netWatts = batteryPower - (inputs.parasiticWatts() || 0);
    if (Math.abs(netWatts) < IDLE_BAND_WATTS) return { state: "idle", netWatts, etaMs: undefined };

    const whLeft = netWatts > 0 ? inputs.whUntilFull() : inputs.whUntilEmpty();
    const etaMs = whLeft === undefined ? undefined : Date.now() + (whLeft / Math.abs(netWatts)) * 3600_000;
    return { state: netWatts > 0 ? "charging" : "discharging", netWatts, etaMs };
  });
}
