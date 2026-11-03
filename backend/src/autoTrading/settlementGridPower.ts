/**
 * A settled day's grid power per 15-min quarter, as the utility meter would have counted it, plus the
 * inverter's own reading next to it (tradingPerformance.ts turns both into SEK).
 *
 * The meter keeps separate import and export registers and counts both within a quarter (37 % of the
 * quarters since 2024-03 have both > 0), so a quarter's import is the mean of the per-reading import and its
 * export the mean of the per-reading export, never the net of a quarter mean. The published
 * meter_equivalent_grid_* fields (grid/meterEquivalentGridRound.ts) are exactly that. A quarter without them
 * (any day before they existed, and the quarter of a restart onto them) is reconstructed from what is
 * stored: 10-s means of the raw reading with the most frequent converter direction, through the same mapping
 * at the calibration passed in ("reconstruct-all" rebuilds every quarter that way). That is the finest grouping a day's query stays small at (~8,600 rows); a bucket
 * that mixes import with export or the grid dropping out loses a little: against the per-reading mapping,
 * −0.005…−0.06 kWh per day on ordinary days and −0.6 of 54 kWh imported on 2026-10-27 (the island-trip
 * evening), where 1-min means lose −1.8.
 */
import type Influx from "influx";
import type { MeterCalibration } from "../config/config.types.ts";
import { meterEquivalentGrid } from "../grid/meterEquivalentGrid.ts";
import { isConverterDirection } from "../grid/meterEquivalentGridRound.ts";
import { SLOT_MS } from "./planner.ts";

export type SettlementQuarter = {
  startMs: number;
  /** Mean meter-equivalent import and export over the quarter (W, each ≥ 0); undefined without grid data */
  meterImportW: number | undefined;
  meterExportW: number | undefined;
  /** Where the meter figures came from */
  meterSource: "published" | "reconstructed" | undefined;
  /** The inverter's mean reading (W, + = import): what the settlement netted before the meter calibration */
  readingW: number | undefined;
  pvW: number | undefined;
  houseW: number | undefined;
};

/**
 * "prefer-published" (the live settlement): a quarter with the published fields uses them, at the calibration
 * that was live when they were recorded, the rest is rebuilt. "reconstruct-all" (settlementReplay.ts, checking
 * or redoing the calibration): every quarter is rebuilt from the raw readings at the calibration passed in, so
 * the published fields can't mix an older calibration into the result.
 */
export type SettlementSource = "prefer-published" | "reconstruct-all";

/** What the rebuild met, for the settlement's log */
export type ReconstructionNotes = {
  /** 10-s buckets without a converter direction, counted as converting */
  bucketsWithoutConverterDirection: number;
  /** "reconstruct-all": quarters whose published fields were set aside for the rebuild */
  publishedQuartersRecomputed: number;
};

export async function querySettlementQuarters(
  influxClient: Influx.InfluxDB,
  dayStartMs: number,
  dayEndMs: number,
  calibration: MeterCalibration,
  source: SettlementSource
): Promise<{ quarters: SettlementQuarter[]; notes: ReconstructionNotes }> {
  const rows = await withQueryTimeout(
    influxClient.query<QuarterRow>(
      `SELECT mean(meter_equivalent_grid_import_watts) AS meter_import, mean(meter_equivalent_grid_export_watts) AS meter_export, ` +
        `count(meter_equivalent_grid_import_watts) AS meter_samples, mean(ac_input_total_active_power) AS grid, ` +
        `count(ac_input_total_active_power) AS grid_samples, mean(solar_input_power_1) AS pv1, mean(solar_input_power_2) AS pv2, ` +
        `mean(ac_output_total_active_power) AS house FROM "mpp-solar" WHERE time >= ${dayStartMs}ms AND time < ${dayEndMs}ms ` +
        `GROUP BY time(15m) fill(none)`
    )
  );
  const quarters = rows.map(quarterFromRow);
  const notes: ReconstructionNotes = { bucketsWithoutConverterDirection: 0, publishedQuartersRecomputed: 0 };
  if (source === "reconstruct-all") {
    for (const quarter of quarters) {
      if (quarter.meterSource === "published") notes.publishedQuartersRecomputed++;
      quarter.meterImportW = undefined;
      quarter.meterExportW = undefined;
      quarter.meterSource = undefined;
    }
  }
  const needingReconstruction = quarters.filter(
    quarter => quarter.meterSource === undefined && quarter.readingW !== undefined
  );
  if (!needingReconstruction.length) return { quarters, notes };

  // Only the span of the quarters that need it: a restart quarter shouldn't pull the whole day (~8,600 rows)
  const rebuildStartMs = Math.min(...needingReconstruction.map(quarter => quarter.startMs));
  const rebuildEndMs = Math.max(...needingReconstruction.map(quarter => quarter.startMs)) + SLOT_MS;
  const bucketRows = await withQueryTimeout(
    influxClient.query<BucketRow>(
      `SELECT mean(ac_input_total_active_power) AS grid, mode("dc/ac_power_direction") AS converter FROM "mpp-solar" ` +
        `WHERE time >= ${rebuildStartMs}ms AND time < ${rebuildEndMs}ms GROUP BY time(${RECONSTRUCTION_BUCKET_SECONDS}s) fill(none)`
    )
  );
  const reconstruction = reconstructQuarterMeterPower(
    bucketRows.map(row => ({
      startMs: Math.round(row.time.getNanoTime() / 1e6),
      phaseSumW: row.grid,
      converter: row.converter,
    })),
    calibration
  );
  for (const quarter of needingReconstruction) {
    const rebuilt = reconstruction.byQuarterStartMs.get(quarter.startMs);
    if (!rebuilt) continue;
    quarter.meterImportW = rebuilt.importW;
    quarter.meterExportW = rebuilt.exportW;
    quarter.meterSource = "reconstructed";
  }
  notes.bucketsWithoutConverterDirection = reconstruction.bucketsWithoutConverterDirection;
  return { quarters, notes };
}

/**
 * A quarter's mean meter-equivalent import and export from short means of the raw reading: each bucket mapped
 * on its own, the quarter the mean over its buckets (the same convention as a quarter mean over whatever
 * points landed in it). A bucket without a converter direction counts as converting, the regime nearly every
 * import is in (the caller logs how many there were).
 */
export function reconstructQuarterMeterPower(
  buckets: { startMs: number; phaseSumW: number | null; converter: string | null }[],
  calibration: MeterCalibration
): {
  byQuarterStartMs: Map<number, { importW: number; exportW: number }>;
  bucketsWithoutConverterDirection: number;
} {
  const sums = new Map<number, { importW: number; exportW: number; buckets: number }>();
  let bucketsWithoutConverterDirection = 0;
  for (const bucket of buckets) {
    if (bucket.phaseSumW === null) continue;
    const converterDirection = isConverterDirection(bucket.converter) ? bucket.converter : undefined;
    if (!converterDirection) bucketsWithoutConverterDirection++;
    const meterEquivalent = meterEquivalentGrid(
      { phase_sum_watts: bucket.phaseSumW, converter_direction: converterDirection ?? "DC to AC" },
      calibration
    );
    const quarterStartMs = Math.floor(bucket.startMs / SLOT_MS) * SLOT_MS;
    const sum = sums.get(quarterStartMs) ?? { importW: 0, exportW: 0, buckets: 0 };
    sum.importW += meterEquivalent.meter_equivalent_grid_import_watts;
    sum.exportW += meterEquivalent.meter_equivalent_grid_export_watts;
    sum.buckets++;
    sums.set(quarterStartMs, sum);
  }
  const byQuarterStartMs = new Map<number, { importW: number; exportW: number }>();
  for (const [quarterStartMs, sum] of sums) {
    byQuarterStartMs.set(quarterStartMs, { importW: sum.importW / sum.buckets, exportW: sum.exportW / sum.buckets });
  }
  return { byQuarterStartMs, bucketsWithoutConverterDirection };
}

/**
 * Whether a quarter's published meter-equivalent fields cover it: they come with every PS round, so they
 * count as many samples as the raw reading unless the quarter straddles the restart that started them.
 */
export function publishedMeterFieldsCoverQuarter(
  publishedSamples: number | null,
  readingSamples: number | null
): boolean {
  if (!publishedSamples || !readingSamples) return false;
  return publishedSamples >= PUBLISHED_COVERAGE_SHARE * readingSamples;
}

const RECONSTRUCTION_BUCKET_SECONDS = 10;
/** A few MQTT messages lost on the way into Influx shouldn't send a quarter to the coarser reconstruction */
const PUBLISHED_COVERAGE_SHARE = 0.95;
const QUERY_TIMEOUT_MS = 60_000;

type QuarterRow = {
  time: { getNanoTime(): number };
  meter_import: number | null;
  meter_export: number | null;
  meter_samples: number | null;
  grid: number | null;
  grid_samples: number | null;
  pv1: number | null;
  pv2: number | null;
  house: number | null;
};

type BucketRow = { time: { getNanoTime(): number }; grid: number | null; converter: string | null };

function quarterFromRow(row: QuarterRow): SettlementQuarter {
  const published =
    publishedMeterFieldsCoverQuarter(row.meter_samples, row.grid_samples) &&
    row.meter_import !== null &&
    row.meter_export !== null;
  const hasPv = row.pv1 !== null || row.pv2 !== null;
  return {
    startMs: Math.round(row.time.getNanoTime() / 1e6),
    meterImportW: published ? row.meter_import ?? undefined : undefined,
    meterExportW: published ? row.meter_export ?? undefined : undefined,
    meterSource: published ? "published" : undefined,
    readingW: row.grid ?? undefined,
    pvW: hasPv ? (row.pv1 ?? 0) + (row.pv2 ?? 0) : undefined,
    houseW: row.house ?? undefined,
  };
}

/** The influx client has no timeout of its own — don't let a hung query stall settlement silently */
async function withQueryTimeout<Result>(query: Promise<Result>): Promise<Result> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      query,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("InfluxDB settlement query timed out")), QUERY_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
