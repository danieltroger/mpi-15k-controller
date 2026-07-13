import { useDatabasePower } from "./useDatabasePower.ts";
import { type Accessor, createMemo } from "solid-js";
import type { get_config_object } from "../config/config.ts";
import { useAhLedger } from "./useAhLedger.ts";

/**
 * The battery-derived accessors the rest of the app consumes. After the Ah cutover this is a thin
 * wrapper around the coulomb-counting ledger (useAhLedger): it owns the InfluxDB client (via
 * useDatabasePower, which also supplies the voltage-based last-full/empty fallback for anchor restore)
 * and clamps the raw Ah SOC for the decision-makers. The old Wh integrate-and-fit system is gone.
 */
export function useBatteryValues(
  configSignal: Awaited<ReturnType<typeof get_config_object>>,
  {
    batteryCurrentAmps,
    smoothedBatteryCurrentAmps,
  }: {
    /** Instantaneous battery amps from hall sensor 2 (drives the Ah ledger). */
    batteryCurrentAmps: Accessor<{ value: number; time: number } | undefined>;
    /** 1-min-smoothed hall amps + last-sample time (drives full/soft-empty anchor detection). */
    smoothedBatteryCurrentAmps: Accessor<{ value: number; time: number } | undefined>;
  }
) {
  const { influxClient, batteryWasLastFullAtAccordingToDatabase, batteryWasLastEmptyAtAccordingToDatabase } =
    useDatabasePower(configSignal);

  const { socAh, latestAnchor } = useAhLedger({
    configSignal,
    influxClient,
    batteryCurrentAmps,
    smoothedBatteryCurrentAmps,
    databaseFullFallbackAt: batteryWasLastFullAtAccordingToDatabase,
    databaseEmptyFallbackAt: batteryWasLastEmptyAtAccordingToDatabase,
  });

  // Consumers (planner start SOC + guard, sell/buy, feed, float workaround, ws) get a sane [0,100]; the
  // raw socAh keeps flowing to InfluxDB unclamped (see ahLedger.ts) so the drift stays visible in Grafana.
  const clampedSocAh = createMemo(() => {
    const soc = socAh();
    if (soc == undefined) return undefined;
    return Math.max(0, Math.min(100, soc));
  });

  return { socAh, clampedSocAh, latestAnchor };
}
