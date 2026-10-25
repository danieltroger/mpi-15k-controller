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

/**
 * Over InfluxDB 1.x's HTTP API (GET /query, epoch=ms), the same settings the `influx` client takes.
 * The credentials travel only as an HTTP Basic Authorization header — never in the URL, which
 * fetch quotes verbatim in its errors (e.g. "Failed to parse URL from …"), and errors reach the
 * state file, the logs and P2 pushes. The endpoint is validated up front so a typo'd
 * influxdb.host fails with a message that names the host and nothing else.
 */
export function influxHttpQuery(settings: NonNullable<Config["influxdb"]>): InfluxQuery {
  const endpoint = influxQueryEndpoint(settings.host);
  const authorization = `Basic ${Buffer.from(`${settings.username}:${settings.password}`).toString("base64")}`;
  return async <Row extends { time: number }>(query: string, timeoutMs: number) => {
    const url = new URL(endpoint);
    url.search = new URLSearchParams({ db: settings.database, q: query, epoch: "ms" }).toString();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal, headers: { Authorization: authorization } });
      if (!response.ok) throw new Error(`InfluxDB HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
      return rowsOf<Row>((await response.json()) as InfluxHttpResponse);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`InfluxDB query to ${endpoint.origin} timed out after ${timeoutMs / 1000}s`);
      }
      // The network cause (ECONNREFUSED host:port, …); the URL holds no credentials
      throw new Error(`InfluxDB request to ${endpoint.origin} failed: ${describeError(error)}`);
    } finally {
      clearTimeout(timer);
    }
  };
}

/** http://host[:port]/query, or a credential-free error naming the bad influxdb.host */
export function influxQueryEndpoint(host: string): URL {
  const invalid = () =>
    new Error(
      `invalid influxdb.host ${JSON.stringify(host)} — expected an IP address or hostname, optionally with :port`
    );
  if (!HOST_PATTERN.test(host)) throw invalid();
  try {
    return new URL("/query", hasPort(host) ? `http://${host}` : `http://${host}:${DEFAULT_PORT}`);
  } catch {
    throw invalid(); // the parser's own message would only repeat the host
  }
}

/** Hostname (underscores allowed, as some LAN names have them), IPv4, or [IPv6], with an optional port — no whitespace, userinfo, path or query */
const HOST_PATTERN = /^(?:[A-Za-z0-9._-]+|\[[0-9A-Fa-f:.]+\])(?::[0-9]+)?$/;
const DEFAULT_PORT = 8086;

/** A port after the host — for [IPv6] only after the closing bracket */
function hasPort(host: string): boolean {
  return host.startsWith("[") ? /\]:[0-9]+$/.test(host) : host.includes(":");
}

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
