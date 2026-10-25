import type Influx from "influx";
import type { Config } from "../config/config.types.ts";
import { describeError } from "./errorDescription.ts";

/**
 * A read-only InfluxQL query returning one plain object per row, with `time` as epoch ms. Two
 * implementations: the controller's shared `influx` client, and plain HTTP for the refit child
 * process — which deliberately has no npm dependency, so it runs without Yarn PnP (~40 MB) and the
 * influx library (~14 MB) loaded on the 512 MB pi.
 */
export type InfluxQuery = <Row extends { time: number }>(query: string, timeoutMs: number) => Promise<Row[]>;

/** Through the controller's `influx` client (InfluxClientProvider) */
export function influxClientQuery(influxClient: Influx.InfluxDB): InfluxQuery {
  return async <Row extends { time: number }>(query: string, timeoutMs: number) => {
    const rows = (await withTimeout(influxClient.query(query), timeoutMs)) as unknown as (Omit<Row, "time"> & {
      time: Date;
    })[];
    return rows.map(row => ({ ...row, time: row.time.getTime() }) as unknown as Row);
  };
}

/** Over InfluxDB 1.x's HTTP API (GET /query, epoch=ms), the same settings the `influx` client takes */
export function influxHttpQuery(settings: NonNullable<Config["influxdb"]>): InfluxQuery {
  const origin = settings.host.includes(":") ? `http://${settings.host}` : `http://${settings.host}:${DEFAULT_PORT}`;
  return async <Row extends { time: number }>(query: string, timeoutMs: number) => {
    const params = new URLSearchParams({
      db: settings.database,
      u: settings.username,
      p: settings.password,
      q: query,
      epoch: "ms",
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${origin}/query?${params}`, { signal: controller.signal });
      if (!response.ok) throw new Error(`InfluxDB HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
      return rowsOf<Row>((await response.json()) as InfluxHttpResponse);
    } catch (error) {
      if (controller.signal.aborted)
        throw new Error(`InfluxDB query to ${origin} timed out after ${timeoutMs / 1000}s`);
      // Keep the network cause (ECONNREFUSED host:port, …) — never the URL, it carries the password
      throw new Error(`InfluxDB request to ${origin} failed: ${describeError(error)}`);
    } finally {
      clearTimeout(timer);
    }
  };
}

const DEFAULT_PORT = 8086;

type InfluxHttpResponse = {
  results?: { error?: string; series?: { columns: string[]; values: (number | string | boolean | null)[][] }[] }[];
};

function rowsOf<Row>(response: InfluxHttpResponse): Row[] {
  const rows: Row[] = [];
  for (const result of response.results ?? []) {
    if (result.error) throw new Error(`InfluxDB: ${result.error}`);
    for (const series of result.series ?? []) {
      for (const values of series.values) {
        rows.push(Object.fromEntries(series.columns.map((column, index) => [column, values[index]])) as Row);
      }
    }
  }
  return rows;
}

async function withTimeout<Value>(promise: Promise<Value>, timeoutMs: number): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`InfluxDB query timed out after ${timeoutMs / 1000}s`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
