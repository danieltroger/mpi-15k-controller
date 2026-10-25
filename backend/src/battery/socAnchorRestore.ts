import type Influx from "influx";
import { type Accessor, createMemo, createResource } from "solid-js";
import type { Config } from "../config/config.types.ts";
import type { InfluxClientAccessor } from "../utilities/InfluxClientProvider.ts";
import { SOC_ANCHORS_MEASUREMENT, type AnchorType } from "./ahLedgerMath.ts";
import { createHistoryQueryRetrier } from "./historyQueryRetrier.ts";
import type { InfluxHistoryOutageMonitor } from "./influxHistoryOutage.ts";
import type { LedgerStartClock } from "./ledgerStartClock.ts";
import { logLog } from "../utilities/logging.ts";
import {
  AWAITING_DATABASE,
  markerOrVoltageFallback,
  NONE_RECORDED,
  type RestoredAnchorTime,
  restoredTimeFromLastRow,
} from "./latestAnchorSelection.ts";

type RestoreContext = {
  influxClient: InfluxClientAccessor;
  ledgerStart: LedgerStartClock;
  outageMonitor: InfluxHistoryOutageMonitor;
};

/**
 * Restores each anchor kind's last pre-start occurrence, preferring the explicit `soc_anchors` markers and
 * falling back to voltage-based queries for full/empty when no marker exists yet (the first deploy, before
 * any marker had been dropped). Soft-empty has no voltage fallback — it only exists once a marker has been
 * written, which is fine (the ledger just uses full/empty until then).
 *
 * Every query retries until InfluxDB answers and reads "awaiting_database" until then, never "nothing
 * found": a failed marker query falling through to an older voltage-based anchor is how the SOC got
 * anchored wrongly after the 2026-10-23 power cycle.
 */
export function socAnchorRestore({
  config,
  ...restoreContext
}: RestoreContext & { config: Accessor<Config> }): Record<AnchorType, Accessor<RestoredAnchorTime>> {
  const fullMarker = restoreLastOccurrence(restoreContext, "last full marker", () => markerQuery("full"));
  const emptyMarker = restoreLastOccurrence(restoreContext, "last empty marker", () => markerQuery("empty"));
  const softEmptyMarker = restoreLastOccurrence(restoreContext, "last soft_empty marker", () =>
    markerQuery("soft_empty")
  );

  const fullBatteryVoltage = createMemo(() => config().full_battery_voltage);
  const fullByVoltage = restoreLastOccurrence(
    restoreContext,
    "last full by battery voltage",
    () => `SELECT last("battery_voltage") FROM "mpp-solar" WHERE "battery_voltage" >= ${fullBatteryVoltage()}`
  );
  const batteryEmptyAt = createMemo(() => config().soc_calculations.battery_empty_at);
  const emptyByVoltage = restoreLastOccurrence(restoreContext, "last empty by battery voltage", () => {
    const emptyAt = batteryEmptyAt();
    return `SELECT last("battery_voltage") FROM "mpp-solar" WHERE ("battery_voltage" <= ${emptyAt} OR "battery_voltage" = ${emptyAt * 10}) AND "battery_voltage" > 0`;
  });

  return {
    full: createMemo(() => markerOrVoltageFallback(fullMarker(), fullByVoltage())),
    empty: createMemo(() => markerOrVoltageFallback(emptyMarker(), emptyByVoltage())),
    soft_empty: softEmptyMarker,
  };
}

/**
 * One `SELECT last(...)` restore query, cut at ledger start (ledgerStartClock.ts) so an answer that
 * arrives minutes late sees exactly the history a prompt boot would have seen. `query` is tracked:
 * a config change it reads re-runs the restore.
 */
function restoreLastOccurrence(
  { influxClient, ledgerStart, outageMonitor }: RestoreContext,
  description: string,
  query: Accessor<string>
): Accessor<RestoredAnchorTime> {
  const retrier = createHistoryQueryRetrier({ description, outageMonitor });
  const [lastOccurrence] = createResource(
    () => ({ database: influxClient(), selectWithoutCutoff: query() }),
    async ({ database, selectWithoutCutoff }) => {
      retrier.cancelPending();
      // No InfluxDB configured means no history to wait for (useBatteryValues errorLogs the missing config).
      if (!database) return NONE_RECORDED;
      const restored = await retrier.run(() =>
        queryLastRow(database, `${selectWithoutCutoff} AND ${ledgerStart.beforeStartCondition()}`)
      );
      if (restored) logLog(`Ah ledger restore: ${description} → ${describeRestoredTime(restored)}`);
      return restored;
    }
  );
  return () => lastOccurrence() ?? AWAITING_DATABASE;
}

function markerQuery(type: AnchorType): string {
  return `SELECT last("value") FROM "${SOC_ANCHORS_MEASUREMENT}" WHERE "type" = '${type}'`;
}

function describeRestoredTime(restored: RestoredAnchorTime): string {
  if (restored.status === "recorded") return new Date(restored.at).toISOString();
  return restored.status === "none_recorded" ? "none recorded" : "awaiting the database";
}

async function queryLastRow(database: Influx.InfluxDB, query: string): Promise<RestoredAnchorTime> {
  const [row] = await database.query(query);
  return restoredTimeFromLastRow(row);
}
