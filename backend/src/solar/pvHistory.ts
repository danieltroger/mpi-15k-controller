import type Influx from "influx";
import { SUBSTEPS_PER_HOUR } from "./pvModel.ts";
import type { PvHistoryHour } from "./pvHistory.types.ts";

/**
 * Inverter production history from InfluxDB as consecutive hours of six 10-min bins, queried a
 * month at a time (fields arrive as separate points, so everything is aggregated per bin rather
 * than joined across fields).
 */
export async function queryPvHistory(
  influxClient: Influx.InfluxDB,
  fromMs: number,
  toMs: number
): Promise<PvHistoryHour[]> {
  const firstHourMs = Math.floor(fromMs / 3600_000) * 3600_000;
  const hourCount = Math.max(0, Math.floor((toMs - firstHourMs) / 3600_000));
  const hours: HourAccumulator[] = Array.from({ length: hourCount }, (_, hour) =>
    emptyHour(firstHourMs + hour * 3600_000)
  );
  for (let chunkStartMs = firstHourMs; chunkStartMs < firstHourMs + hourCount * 3600_000; chunkStartMs += CHUNK_MS) {
    const chunkEndMs = Math.min(chunkStartMs + CHUNK_MS, firstHourMs + hourCount * 3600_000);
    const binRows = await queryWithTimeout<BinRow>(
      influxClient,
      `SELECT mean(solar_input_power_1) AS mppt1_watts, mean(solar_input_power_2) AS mppt2_watts, ` +
        `mean(solar_input_voltage_1) AS mppt1_volts, mean(solar_input_voltage_2) AS mppt2_volts, ` +
        `max(battery_voltage) AS battery_volts_max, mean(ac_input_total_active_power) AS grid_watts, ` +
        `count(battery_voltage) AS frames FROM "mpp-solar" WHERE time >= ${chunkStartMs}ms AND time < ${chunkEndMs}ms GROUP BY time(10m)`
    );
    for (const row of binRows) {
      const binStartMs = row.time.getTime();
      const hourIndex = Math.floor((binStartMs - firstHourMs) / 3600_000);
      const hour = hours[hourIndex];
      if (!hour) continue;
      const bin = Math.floor((binStartMs - hour.hourStartMs) / 600_000);
      const voltageScale = binStartMs < TELEMETRY_SCALED_BY_TEN_UNTIL_MS ? 0.1 : 1;
      hour.binHasData[bin] = (row.frames ?? 0) > 0;
      hour.mppt1Watts[bin] = row.mppt1_watts ?? Number.NaN;
      hour.mppt2Watts[bin] = row.mppt2_watts ?? Number.NaN;
      hour.mppt1Volts[bin] = (row.mppt1_volts ?? Number.NaN) * voltageScale;
      hour.mppt2Volts[bin] = (row.mppt2_volts ?? Number.NaN) * voltageScale;
      if (row.battery_volts_max != null) {
        hour.batteryVoltsMax = Math.max(hour.batteryVoltsMax, row.battery_volts_max * voltageScale);
      }
      if (row.grid_watts != null) {
        hour.gridSum += row.grid_watts;
        hour.gridBins += 1;
      }
    }
    const socRows = await queryWithTimeout<SocRow>(
      influxClient,
      `SELECT max(soc_ah) AS soc_ah, max(average_soc) AS average_soc FROM soc_values ` +
        `WHERE time >= ${chunkStartMs}ms AND time < ${chunkEndMs}ms GROUP BY time(1h) fill(none)`
    );
    for (const row of socRows) {
      const hour = hours[Math.floor((row.time.getTime() - firstHourMs) / 3600_000)];
      // soc_ah is the Ah ledger (since 2026-07); before it only the old average_soc existed
      if (hour) hour.socPercentMax = row.soc_ah ?? row.average_soc ?? Number.NaN;
    }
  }
  return hours.map(({ gridSum, gridBins, ...hour }) => ({
    ...hour,
    gridWattsMean: gridBins ? gridSum / gridBins : Number.NaN,
  }));
}

/** Hourly mean power per string over a recent window (for the snow nowcast and accuracy logging). */
export async function queryHourlyStringWatts(
  influxClient: Influx.InfluxDB,
  fromMs: number,
  toMs: number,
  rewiredAtMs: number
): Promise<Map<number, { string1: number; string2: number }>> {
  const rows = await queryWithTimeout<{ time: Date; mppt1_watts: number | null; mppt2_watts: number | null }>(
    influxClient,
    `SELECT mean(solar_input_power_1) AS mppt1_watts, mean(solar_input_power_2) AS mppt2_watts FROM "mpp-solar" ` +
      `WHERE time >= ${fromMs}ms AND time < ${toMs}ms GROUP BY time(1h) fill(none)`
  );
  const byHour = new Map<number, { string1: number; string2: number }>();
  for (const row of rows) {
    if (row.mppt1_watts == null || row.mppt2_watts == null) continue;
    const hourStartMs = row.time.getTime();
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
const QUERY_TIMEOUT_MS = 90_000;

type BinRow = {
  time: Date;
  mppt1_watts: number | null;
  mppt2_watts: number | null;
  mppt1_volts: number | null;
  mppt2_volts: number | null;
  battery_volts_max: number | null;
  grid_watts: number | null;
  frames: number | null;
};

type SocRow = { time: Date; soc_ah: number | null; average_soc: number | null };

type HourAccumulator = PvHistoryHour & { gridSum: number; gridBins: number };

function emptyHour(hourStartMs: number): HourAccumulator {
  return {
    hourStartMs,
    mppt1Watts: Array<number>(SUBSTEPS_PER_HOUR).fill(Number.NaN),
    mppt2Watts: Array<number>(SUBSTEPS_PER_HOUR).fill(Number.NaN),
    mppt1Volts: Array<number>(SUBSTEPS_PER_HOUR).fill(Number.NaN),
    mppt2Volts: Array<number>(SUBSTEPS_PER_HOUR).fill(Number.NaN),
    binHasData: Array<boolean>(SUBSTEPS_PER_HOUR).fill(false),
    batteryVoltsMax: Number.NEGATIVE_INFINITY,
    gridWattsMean: Number.NaN,
    socPercentMax: Number.NaN,
    gridSum: 0,
    gridBins: 0,
  };
}

async function queryWithTimeout<Row>(influxClient: Influx.InfluxDB, query: string): Promise<Row[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return (await Promise.race([
      influxClient.query(query),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`InfluxDB query timed out after ${QUERY_TIMEOUT_MS / 1000}s`)),
          QUERY_TIMEOUT_MS
        );
      }),
    ])) as unknown as Row[];
  } finally {
    clearTimeout(timer);
  }
}
