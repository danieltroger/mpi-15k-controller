import { type Accessor, createMemo } from "solid-js";
import type { get_config_object } from "../config/config.ts";
import type { InfluxClientAccessor } from "../utilities/InfluxClientProvider.ts";
import { socAnchorRestore } from "./socAnchorRestore.ts";
import { ahLedger } from "./ahLedger.ts";
import type { InfluxHistoryOutageMonitor } from "./influxHistoryOutage.ts";
import { createLedgerStartClock } from "./ledgerStartClock.ts";
import { sameAnchor, type SelectedAnchor, selectLatestAnchor } from "./latestAnchorSelection.ts";

/** The latest live anchor events, as anchorDetection.ts latches them. */
export type LiveAnchorEvents = {
  lastFullEventAt: Accessor<number | undefined>;
  lastEmptyEventAt: Accessor<number | undefined>;
  lastSoftEmptyEventAt: Accessor<number | undefined>;
};

/**
 * Wires the Ah ledger together: the cross-restart anchor restore from InfluxDB, the single "latest anchor
 * of any type" the ledger hangs off (unknown until the restore has fully answered, unless a live event
 * fired meanwhile), and the ledger itself. Takes the live anchor events and hall amps as signals and the
 * InfluxDB client explicitly — no MQTT, no ADC — so socHistoryOutage.selftest.ts can run it against a fake
 * InfluxDB.
 */
export function useAhLedger({
  configSignal,
  influxClient,
  batteryCurrentAmps,
  liveAnchorEvents,
  outageMonitor,
}: {
  configSignal: Awaited<ReturnType<typeof get_config_object>>;
  influxClient: InfluxClientAccessor;
  batteryCurrentAmps: Accessor<{ value: number; time: number } | undefined>;
  liveAnchorEvents: LiveAnchorEvents;
  outageMonitor: InfluxHistoryOutageMonitor;
}) {
  const [config] = configSignal;
  const ledgerStart = createLedgerStartClock();
  const restoredAt = socAnchorRestore({ config, influxClient, ledgerStart, outageMonitor });

  // equals-guarded so unrelated config writes (the online drain/capacity persist, schedule edits, …)
  // can't churn the DB integral query or spuriously re-anchor.
  const latestAnchor = createMemo<SelectedAnchor | undefined>(
    () =>
      selectLatestAnchor({
        liveEventAt: {
          full: liveAnchorEvents.lastFullEventAt(),
          empty: liveAnchorEvents.lastEmptyEventAt(),
          soft_empty: liveAnchorEvents.lastSoftEmptyEventAt(),
        },
        restoredAt: {
          full: restoredAt.full(),
          empty: restoredAt.empty(),
          soft_empty: restoredAt.soft_empty(),
        },
        softEmptySocPercent: config().soc_calculations.ah_ledger.soft_empty.soc_percent,
      }),
    undefined,
    { equals: sameAnchor }
  );

  const { socAh } = ahLedger({
    configSignal,
    influxClient,
    batteryCurrentAmps,
    latestAnchor,
    ledgerStart,
    outageMonitor,
  });

  // latestAnchor is exposed too: it's the Ah system's "last full/empty/soft-empty" the frontend shows
  // in place of the deleted Wh totalLastFull/totalLastEmpty.
  return { socAh, latestAnchor };
}
