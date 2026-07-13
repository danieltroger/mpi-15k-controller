import { type Accessor, createMemo } from "solid-js";
import type { get_config_object } from "../config/config.ts";
import type { InfluxClientAccessor } from "./useDatabasePower.ts";
import { anchorDetection } from "./anchorDetection.ts";
import { socAnchorRestore } from "./socAnchorRestore.ts";
import { ahLedger } from "./ahLedger.ts";
import type { LedgerAnchor } from "./ahLedgerMath.ts";

/**
 * Wires the Ah ledger together: live edge detection + marker publishing, cross-restart restore from
 * soc_anchors (voltage-based fallback for full/empty), the single "latest anchor of any type" the ledger
 * hangs off, and the ledger itself. Consumes the hall amps *signals* (not the ADC) so it stays importable
 * on machines without the arm64 sensor addon.
 */
export function useAhLedger({
  configSignal,
  influxClient,
  batteryCurrentAmps,
  smoothedBatteryCurrentAmps,
  databaseFullFallbackAt,
  databaseEmptyFallbackAt,
}: {
  configSignal: Awaited<ReturnType<typeof get_config_object>>;
  influxClient: InfluxClientAccessor;
  batteryCurrentAmps: Accessor<{ value: number; time: number } | undefined>;
  smoothedBatteryCurrentAmps: Accessor<{ value: number; time: number } | undefined>;
  databaseFullFallbackAt: Accessor<number | undefined>;
  databaseEmptyFallbackAt: Accessor<number | undefined>;
}) {
  const [config] = configSignal;

  const { lastFullEventAt, lastEmptyEventAt, lastSoftEmptyEventAt } = anchorDetection({
    config,
    smoothedBatteryCurrentAmps,
  });
  const { restoredFullAt, restoredEmptyAt, restoredSoftEmptyAt } = socAnchorRestore({
    influxClient,
    databaseFullFallbackAt,
    databaseEmptyFallbackAt,
  });

  const fullAt = createMemo(() => laterOf(lastFullEventAt(), restoredFullAt()));
  const emptyAt = createMemo(() => laterOf(lastEmptyEventAt(), restoredEmptyAt()));
  const softEmptyAt = createMemo(() => laterOf(lastSoftEmptyEventAt(), restoredSoftEmptyAt()));

  // The anchor the ledger hangs off: whichever kind fired most recently, tagged with its known SOC.
  // equals-guarded so unrelated config writes (the online drain/capacity persist, schedule edits, …)
  // can't churn the DB integral query or spuriously re-anchor.
  const latestAnchor = createMemo<LedgerAnchor | undefined>(
    () => {
      const softEmptySocPercent = config().soc_calculations.ah_ledger.soft_empty.soc_percent;
      const candidates: LedgerAnchor[] = [];
      const fullTime = fullAt();
      const emptyTime = emptyAt();
      const softEmptyTime = softEmptyAt();
      if (fullTime != undefined) candidates.push({ at: fullTime, soc: 100, type: "full" });
      if (emptyTime != undefined) candidates.push({ at: emptyTime, soc: 0, type: "empty" });
      if (softEmptyTime != undefined)
        candidates.push({ at: softEmptyTime, soc: softEmptySocPercent, type: "soft_empty" });
      if (!candidates.length) return undefined;
      return candidates.reduce((latest, candidate) => (candidate.at > latest.at ? candidate : latest));
    },
    undefined,
    { equals: (a, b) => a?.at === b?.at && a?.soc === b?.soc && a?.type === b?.type }
  );

  const { socAh } = ahLedger({ configSignal, influxClient, batteryCurrentAmps, latestAnchor });

  // latestAnchor is exposed too: it's the Ah system's "last full/empty/soft-empty" the frontend shows
  // in place of the deleted Wh totalLastFull/totalLastEmpty.
  return { socAh, latestAnchor };
}

function laterOf(a: number | undefined, b: number | undefined): number | undefined {
  if (a == undefined) return b;
  if (b == undefined) return a;
  return Math.max(a, b);
}
