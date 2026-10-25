import type { InfluxQuery } from "./influxQuery.ts";
import { SUBSTEPS_PER_HOUR } from "./pvModel.ts";
import type { PvHistoryColumns } from "./pvHistory.types.ts";

/**
 * Inverter production history from InfluxDB as consecutive hours of six 10-min bins, written
 * straight into typed arrays (2.5 years is ~135k bins — per-hour objects cost ~10× the memory),
 * queried a month at a time. Fields arrive as separate points, so everything is aggregated per
 * bin rather than joined across fields.
 */
export async function queryPvHistory(query: InfluxQuery, fromMs: number, toMs: number): Promise<PvHistoryColumns> {
  const firstHourMs = Math.floor(fromMs / 3600_000) * 3600_000;
  const hourCount = Math.max(0, Math.floor((toMs - firstHourMs) / 3600_000));
  const binCount = hourCount * SUBSTEPS_PER_HOUR;
  const history: PvHistoryColumns = {
    firstHourMs,
    hourCount,
    mppt1Watts: new Float64Array(binCount).fill(Number.NaN),
    mppt2Watts: new Float64Array(binCount).fill(Number.NaN),
    mppt1Volts: new Float64Array(binCount).fill(Number.NaN),
    mppt2Volts: new Float64Array(binCount).fill(Number.NaN),
    binHasData: new Uint8Array(binCount),
    batteryVoltsMax: new Float64Array(hourCount).fill(Number.NEGATIVE_INFINITY),
    gridWattsMean: new Float64Array(hourCount).fill(Number.NaN),
    socPercentMax: new Float64Array(hourCount).fill(Number.NaN),
  };
  const gridSum = new Float64Array(hourCount);
  const gridBins = new Uint8Array(hourCount);
  const endMs = firstHourMs + hourCount * 3600_000;
  for (let chunkStartMs = firstHourMs; chunkStartMs < endMs; chunkStartMs += CHUNK_MS) {
    const chunkEndMs = Math.min(chunkStartMs + CHUNK_MS, endMs);
    const binRows = await query<BinRow>(
      `SELECT mean(solar_input_power_1) AS mppt1_watts, mean(solar_input_power_2) AS mppt2_watts, ` +
        `mean(solar_input_voltage_1) AS mppt1_volts, mean(solar_input_voltage_2) AS mppt2_volts, ` +
        `max(battery_voltage) AS battery_volts_max, mean(ac_input_total_active_power) AS grid_watts, ` +
        `count(battery_voltage) AS frames FROM "mpp-solar" WHERE time >= ${chunkStartMs}ms AND time < ${chunkEndMs}ms GROUP BY time(10m)`,
      HISTORY_QUERY_TIMEOUT_MS
    );
    for (const row of binRows) {
      const binStartMs = row.time;
      const bin = Math.floor((binStartMs - firstHourMs) / 600_000);
      if (bin < 0 || bin >= binCount) continue;
      const hour = Math.floor(bin / SUBSTEPS_PER_HOUR);
      const voltageScale = binStartMs < TELEMETRY_SCALED_BY_TEN_UNTIL_MS ? 0.1 : 1;
      history.binHasData[bin] = (row.frames ?? 0) > 0 ? 1 : 0;
      history.mppt1Watts[bin] = row.mppt1_watts ?? Number.NaN;
      history.mppt2Watts[bin] = row.mppt2_watts ?? Number.NaN;
      history.mppt1Volts[bin] = (row.mppt1_volts ?? Number.NaN) * voltageScale;
      history.mppt2Volts[bin] = (row.mppt2_volts ?? Number.NaN) * voltageScale;
      if (row.battery_volts_max != null) {
        history.batteryVoltsMax[hour] = Math.max(history.batteryVoltsMax[hour], row.battery_volts_max * voltageScale);
      }
      if (row.grid_watts != null) {
        gridSum[hour] += row.grid_watts;
        gridBins[hour] += 1;
      }
    }
    const socRows = await query<SocRow>(
      `SELECT max(soc_ah) AS soc_ah, max(average_soc) AS average_soc FROM soc_values ` +
        `WHERE time >= ${chunkStartMs}ms AND time < ${chunkEndMs}ms GROUP BY time(1h) fill(none)`,
      HISTORY_QUERY_TIMEOUT_MS
    );
    for (const row of socRows) {
      const hour = Math.floor((row.time - firstHourMs) / 3600_000);
      // soc_ah is the Ah ledger (since 2026-07); before it only the old average_soc existed
      if (hour >= 0 && hour < hourCount) history.socPercentMax[hour] = row.soc_ah ?? row.average_soc ?? Number.NaN;
    }
  }
  gridSum.forEach((sum, hour) => {
    if (gridBins[hour]) history.gridWattsMean[hour] = sum / gridBins[hour];
  });
  return history;
}

/** Hourly mean power per string over a recent window (for the snow nowcast and accuracy logging). */
export async function queryHourlyStringWatts(
  query: InfluxQuery,
  fromMs: number,
  toMs: number,
  rewiredAtMs: number,
  timeoutMs: number
): Promise<Map<number, { string1: number; string2: number }>> {
  const rows = await query<{ time: number; mppt1_watts: number | null; mppt2_watts: number | null }>(
    `SELECT mean(solar_input_power_1) AS mppt1_watts, mean(solar_input_power_2) AS mppt2_watts FROM "mpp-solar" ` +
      `WHERE time >= ${fromMs}ms AND time < ${toMs}ms GROUP BY time(1h) fill(none)`,
    timeoutMs
  );
  const byHour = new Map<number, { string1: number; string2: number }>();
  for (const row of rows) {
    if (row.mppt1_watts == null || row.mppt2_watts == null) continue;
    const hourStartMs = row.time;
    byHour.set(
      hourStartMs,
      hourStartMs < rewiredAtMs
        ? { string1: row.mppt1_watts + row.mppt2_watts, string2: Number.NaN }
        : { string1: row.mppt1_watts, string2: row.mppt2_watts }
    );
  }
  return byHour;
}

/**
 * Before the pi17 protocol fix (2025-10-17 21:30 UTC) the inverter's voltages and currents were
 * logged ×10. Power was always right.
 */
const TELEMETRY_SCALED_BY_TEN_UNTIL_MS = Date.parse("2025-10-17T21:30:00Z");
/** One month per query keeps each response a few thousand rows */
const CHUNK_MS = 31 * 86_400_000;
/** For the monthly refit's history chunks (in the refit child process); interactive callers pass their own, shorter one */
export const HISTORY_QUERY_TIMEOUT_MS = 90_000;

type BinRow = {
  time: number;
  mppt1_watts: number | null;
  mppt2_watts: number | null;
  mppt1_volts: number | null;
  mppt2_volts: number | null;
  battery_volts_max: number | null;
  grid_watts: number | null;
  frames: number | null;
};

type SocRow = { time: number; soc_ah: number | null; average_soc: number | null };
