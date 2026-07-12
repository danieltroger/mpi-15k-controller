import type Influx from "influx";
import { type Accessor, createMemo, createResource } from "solid-js";
import type { InfluxClientAccessor } from "./useDatabasePower.ts";
import { warnLog } from "../utilities/logging.ts";
import { SOC_ANCHORS_MEASUREMENT, type AnchorType } from "./ahLedgerMath.ts";

/**
 * Restores the Ah ledger's anchor times across restarts, preferring the explicit `soc_anchors` markers
 * this build writes and falling back to the Wh system's voltage-based queries when no marker exists yet
 * (the first deploy, before any marker has been dropped). Soft-empty has no voltage fallback — it only
 * exists once a marker has been written, which is fine (the ledger just uses full/empty until then).
 */
export function socAnchorRestore({
  influxClient,
  databaseFullFallbackAt,
  databaseEmptyFallbackAt,
}: {
  influxClient: InfluxClientAccessor;
  databaseFullFallbackAt: Accessor<number | undefined>;
  databaseEmptyFallbackAt: Accessor<number | undefined>;
}) {
  const [fullMarkerAt] = createResource(influxClient, database => queryLastAnchorMarker(database, "full"));
  const [emptyMarkerAt] = createResource(influxClient, database => queryLastAnchorMarker(database, "empty"));
  const [softEmptyMarkerAt] = createResource(influxClient, database => queryLastAnchorMarker(database, "soft_empty"));

  return {
    restoredFullAt: createMemo(() => fullMarkerAt() ?? databaseFullFallbackAt()),
    restoredEmptyAt: createMemo(() => emptyMarkerAt() ?? databaseEmptyFallbackAt()),
    restoredSoftEmptyAt: createMemo(() => softEmptyMarkerAt()),
  };
}

async function queryLastAnchorMarker(
  database: Influx.InfluxDB | undefined,
  type: AnchorType
): Promise<number | undefined> {
  if (!database) return undefined;
  try {
    const [response] = await database.query(`SELECT last("value") FROM "${SOC_ANCHORS_MEASUREMENT}" WHERE "type" = '${type}'`);
    const timeOfLastMarker = (response as { time?: { getNanoTime: () => number } })?.time?.getNanoTime?.();
    if (timeOfLastMarker !== undefined && !isNaN(timeOfLastMarker)) {
      return Math.round(timeOfLastMarker / 1000 / 1000);
    }
    // No marker for this type yet (e.g. first deploy) — caller falls back to the voltage-based query.
    return undefined;
  } catch (error) {
    warnLog(`Failed to restore last ${type} anchor from soc_anchors; falling back to voltage query`, error);
    return undefined;
  }
}
