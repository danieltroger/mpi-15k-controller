/**
 * Shared harness for the socHistoryOutage selftests: the real useAhLedger on a throwaway Solid root, a
 * node-influx client aimed at a local port, and a fake InfluxDB 1.x that answers the ledger's six queries.
 * Only ever talks to 127.0.0.1 — never to a real InfluxDB.
 */
import http from "http";
import net from "net";
import Influx, { type IPoolOptions } from "influx";
import { type Accessor, catchError, createRoot, createSignal, type Setter } from "solid-js";
import { default_config } from "../config/config.ts";
import type { Config } from "../config/config.types.ts";
import { NowProvider } from "../utilities/useNow.ts";
import { computeSocAh } from "./ahLedgerMath.ts";
import type { HistoryRetryTiming } from "./historyRetryPolicy.ts";
import type { InfluxHistoryOutageMonitor } from "./influxHistoryOutage.ts";
import { useAhLedger } from "./useAhLedger.ts";

export const HOUR_MS = 3_600_000;
// Production retries 30 s → 60 s cap and escalates at 15 min; same policy, shrunk to test speed.
export const TEST_TIMING: HistoryRetryTiming = {
  firstRetryDelayMs: 100,
  maxRetryDelayMs: 400,
  requestTimeoutMs: 500,
  escalateAfterMs: 1_500,
  warnEveryMs: 1_000,
};
// Absurd on purpose: a couple of seconds of samples must move the SOC by whole percentage points.
export const OUTAGE_AMPS = 72_000;
// node-influx takes a failed host out of its pool for up to 10 s. Production's 30 s first retry outlasts
// that; the test's 100 ms retries wouldn't, so keep the host in the pool and let every retry hit the port.
const NEVER_DISABLE_HOST: NonNullable<IPoolOptions["backoff"]> = {
  getDelay: () => 0,
  next: () => NEVER_DISABLE_HOST,
  reset: () => NEVER_DISABLE_HOST,
};

export type LedgerHarness = {
  ledger: ReturnType<typeof useAhLedger>;
  ledgerErrors: unknown[];
  config: Accessor<Config>;
  setBatteryCurrentAmps: Setter<{ value: number; time: number } | undefined>;
  setLastFullEventAt: Setter<number | undefined>;
  dispose: () => void;
};

export type FakeHistory = {
  fullMarkerAt: number;
  softEmptyMarkerAt: number;
  fullByVoltageAt: number;
  emptyByVoltageAt: number;
  chargeIntegralAh: number;
  /** Answer the integral with an HTTP error (InfluxDB flapping while it boots). */
  failChargeIntegral?: boolean;
};

export type FakeInflux = { queries: string[]; close: () => Promise<void> };

/** The real useAhLedger on its own root, as main() builds it — minus MQTT, ADC and the serial engine. */
export function startLedger(client: Influx.InfluxDB, outageMonitor: InfluxHistoryOutageMonitor): LedgerHarness {
  const ledgerErrors: unknown[] = [];
  const configSignal = createSignal<Config>(structuredClone(default_config));
  const [batteryCurrentAmps, setBatteryCurrentAmps] = createSignal<{ value: number; time: number }>();
  const [lastFullEventAt, setLastFullEventAt] = createSignal<number>();
  return createRoot(dispose => {
    let ledger: ReturnType<typeof useAhLedger> | undefined;
    catchError(
      () =>
        NowProvider({
          get children() {
            ledger = useAhLedger({
              configSignal,
              influxClient: () => client,
              batteryCurrentAmps,
              liveAnchorEvents: {
                lastFullEventAt,
                lastEmptyEventAt: () => undefined,
                lastSoftEmptyEventAt: () => undefined,
              },
              outageMonitor,
            });
            return undefined;
          },
        }),
      error => ledgerErrors.push(error)
    );
    if (!ledger) throw new Error(`useAhLedger didn't start: ${ledgerErrors.map(String).join(", ")}`);
    return { ledger, ledgerErrors, config: configSignal[0], setBatteryCurrentAmps, setLastFullEventAt, dispose };
  });
}

export function createTestClient(port: number): Influx.InfluxDB {
  return new Influx.InfluxDB({
    host: "127.0.0.1",
    port,
    database: "selftest",
    username: "selftest",
    password: "selftest",
    pool: { backoff: NEVER_DISABLE_HOST, requestTimeout: TEST_TIMING.requestTimeoutMs },
  });
}

/** History as InfluxDB reports it a moment after `nowMs`: soft-empty 5 h ago is the newest anchor. */
export function historyEndingAt(nowMs: number, chargeIntegralAh: number): FakeHistory {
  return {
    fullMarkerAt: nowMs - 20 * HOUR_MS,
    softEmptyMarkerAt: nowMs - 5 * HOUR_MS,
    fullByVoltageAt: nowMs - 30 * HOUR_MS,
    emptyByVoltageAt: nowMs - 40 * HOUR_MS,
    chargeIntegralAh,
  };
}

/** Samples arrive synchronously into the ledger, so the monotonic times taken here bracket its own. */
export async function feedConstantAmps(
  harness: LedgerHarness,
  amps: number,
  sampleCount: number,
  intervalMs: number
): Promise<{ firstAtMonotonicMs: number; lastAtMonotonicMs: number }> {
  let firstAtMonotonicMs = NaN;
  let lastAtMonotonicMs = NaN;
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
    if (sampleIndex) await sleep(intervalMs);
    harness.setBatteryCurrentAmps({ value: amps, time: Date.now() });
    lastAtMonotonicMs = performance.now();
    if (!sampleIndex) firstAtMonotonicMs = lastAtMonotonicMs;
  }
  return { firstAtMonotonicMs, lastAtMonotonicMs };
}

/** ∫ of a constant current between two sample instants, in Ah. */
export function constantAmpsAh(amps: number, fromMonotonicMs: number, toMonotonicMs: number): number {
  return (amps * (toMonotonicMs - fromMonotonicMs)) / HOUR_MS;
}

export function expectedSocFromSoftEmpty(history: FakeHistory, integralAh: number): number {
  const { soft_empty, drain_a, capacity_ah } = default_config.soc_calculations.ah_ledger;
  return computeSocAh({
    anchorSoc: soft_empty.soc_percent,
    integralAh,
    drainA: drain_a,
    elapsedHours: (Date.now() - history.softEmptyMarkerAt) / HOUR_MS,
    capacityAh: capacity_ah,
  });
}

/** Answers the ledger's six InfluxQL queries like InfluxDB 1.x would, recording each one. */
export async function startFakeInflux(port: number, history: FakeHistory): Promise<FakeInflux> {
  const queries: string[] = [];
  const server = http.createServer((request, response) => {
    const query = new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("q") ?? "";
    queries.push(query);
    const body = fakeInfluxAnswer(query, history);
    response.writeHead(body ? 200 : 400, { "content-type": "application/json" });
    response.end(JSON.stringify(body ?? { error: `selftest fake InfluxDB refuses: ${query}` }));
  });
  await new Promise<void>(resolve => server.listen(port, "127.0.0.1", resolve));
  return { queries, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

/** A port nothing listens on (bound once to learn a free one, then released). */
export async function findClosedPort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  await new Promise<void>(resolve => probe.close(() => resolve()));
  if (!address || typeof address === "string") throw new Error("could not determine a free local port");
  return address.port;
}

export async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(25);
  }
  return predicate();
}

export function sleep(durationMs: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, durationMs));
}

function fakeInfluxAnswer(query: string, history: FakeHistory) {
  if (query.includes("integral(")) {
    return history.failChargeIntegral
      ? undefined
      : seriesAnswer("current_values", "charge", 0, history.chargeIntegralAh);
  }
  if (query.includes(`"type" = 'full'`)) return seriesAnswer("soc_anchors", "last", history.fullMarkerAt, 1);
  if (query.includes(`"type" = 'soft_empty'`)) return seriesAnswer("soc_anchors", "last", history.softEmptyMarkerAt, 1);
  if (query.includes(`"type" = 'empty'`)) return { results: [{ statement_id: 0 }] }; // no empty marker yet
  if (query.includes(`"battery_voltage" >=`)) return seriesAnswer("mpp-solar", "last", history.fullByVoltageAt, 58.4);
  if (query.includes(`"battery_voltage" <=`)) return seriesAnswer("mpp-solar", "last", history.emptyByVoltageAt, 46);
  return undefined;
}

function seriesAnswer(measurement: string, column: string, atMs: number, value: number) {
  return {
    results: [
      {
        statement_id: 0,
        series: [{ name: measurement, columns: ["time", column], values: [[new Date(atMs).toISOString(), value]] }],
      },
    ],
  };
}
