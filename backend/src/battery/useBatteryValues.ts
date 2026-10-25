import { type Accessor, createEffect, createMemo } from "solid-js";
import type { get_config_object } from "../config/config.ts";
import { useInfluxClient } from "../utilities/InfluxClientProvider.ts";
import { errorLog } from "../utilities/logging.ts";
import { anchorDetection } from "./anchorDetection.ts";
import { useAhLedger } from "./useAhLedger.ts";
import { influxHistoryOutage } from "./influxHistoryOutage.ts";
import { publishSocAh } from "./publishSocAh.ts";

/**
 * The battery-derived accessors the rest of the app consumes. After the Ah cutover this is a thin
 * wrapper around the coulomb-counting ledger (useAhLedger): it hands the ledger the shared InfluxDB
 * client and the live anchor events, publishes the raw Ah SOC and clamps it for the decision-makers.
 * The old Wh integrate-and-fit system is gone.
 *
 * Nothing here throws when InfluxDB is unreachable: the history queries retry in the background and the
 * SOC reads undefined until they answer (every consumer treats undefined as "don't act on SOC").
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
  const [config] = configSignal;
  const influxClient = useInfluxClient();
  createEffect(() => {
    if (!influxClient()) {
      errorLog(
        "No influxdb config found (or incomplete), please configure influxdb.host, influxdb.database, influxdb.username and influxdb.password in config.json"
      );
    }
  });

  const liveAnchorEvents = anchorDetection({ config, smoothedBatteryCurrentAmps });
  const { socAh, latestAnchor } = useAhLedger({
    configSignal,
    influxClient,
    batteryCurrentAmps,
    liveAnchorEvents,
    outageMonitor: influxHistoryOutage,
  });
  publishSocAh({ config, socAh });

  // Consumers (planner start SOC + guard, sell/buy, feed, float workaround, ws) get a sane [0,100]; the
  // raw socAh keeps flowing to InfluxDB unclamped (see publishSocAh.ts) so the drift stays visible in Grafana.
  const clampedSocAh = createMemo(() => {
    const soc = socAh();
    if (soc == undefined) return undefined;
    return Math.max(0, Math.min(100, soc));
  });

  // The raw hall amps are passed through for consumers that act on the battery current itself: the
  // buy-window end step-down checks the charge current really dropped before disabling AC charging
  return { socAh, clampedSocAh, latestAnchor, batteryCurrentAmps };
}
