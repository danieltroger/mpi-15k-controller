/**
 * Integration self-test of the Ah ledger booting while InfluxDB is down (the 2026-10-23 power cycle).
 * useAhLedger runs for real against a node-influx client pointed at a closed local port, then a fake
 * InfluxDB comes up on that port with canned history:
 *
 *  A. while down: nothing throws, the history queries keep retrying, the SOC and anchor stay unknown, and
 *     the outage escalates with exactly one errorLog;
 *  B. once it answers: the SOC initialises from the right (newest) anchor, the queries cut the history at
 *     ledger start, and the charge accumulated during the outage is part of the SOC;
 *  C. a live anchor during an outage gives a SOC without InfluxDB, and disposing the root (what every
 *     main() crash-restart does) stops the retries.
 *
 * Only ever talks to 127.0.0.1 on a throwaway port — never to a real InfluxDB.
 * Run from backend/ with:  yarn node src/battery/socHistoryOutage.selftest.ts   (~8 s)
 */
import process from "process";
import http from "http";
import net from "net";
import Influx, { type IPoolOptions } from "influx";
import { catchError, createRoot, createSignal, type Setter } from "solid-js";
import { default_config } from "../config/config.ts";
import type { Config } from "../config/config.types.ts";
import { setOnErrorLog } from "../utilities/logging.ts";
import { NowProvider } from "../utilities/useNow.ts";
import { computeSocAh } from "./ahLedgerMath.ts";
import type { HistoryRetryTiming } from "./historyRetryPolicy.ts";
import { createInfluxHistoryOutageMonitor, type InfluxHistoryOutageMonitor } from "./influxHistoryOutage.ts";
import { useAhLedger } from "./useAhLedger.ts";

const HARD_TIMEOUT_MS = 60_000;
const HOUR_MS = 3_600_000;
// Production backs off 30 s → 5 min and escalates at 15 min; same policy, shrunk to test speed.
const TEST_TIMING: HistoryRetryTiming = {
  firstRetryDelayMs: 100,
  maxRetryDelayMs: 400,
  escalateAfterMs: 1_500,
  warnEveryMs: 1_000,
};
// node-influx takes a failed host out of its pool for up to 10 s. Production's 30 s first retry outlasts
// that; the test's 100 ms retries wouldn't, so keep the host in the pool and let every retry hit the port.
const NEVER_DISABLE_HOST: NonNullable<IPoolOptions["backoff"]> = {
  getDelay: () => 0,
  next: () => NEVER_DISABLE_HOST,
  reset: () => NEVER_DISABLE_HOST,
};
// Absurd on purpose: a couple of seconds of samples must move the SOC by whole percentage points.
const OUTAGE_AMPS = 72_000;

type LedgerHarness = {
  ledger: ReturnType<typeof useAhLedger>;
  ledgerErrors: unknown[];
  setBatteryCurrentAmps: Setter<{ value: number; time: number } | undefined>;
  setLastFullEventAt: Setter<number | undefined>;
  dispose: () => void;
};
type FakeHistory = {
  fullMarkerAt: number;
  softEmptyMarkerAt: number;
  fullByVoltageAt: number;
  emptyByVoltageAt: number;
  chargeIntegralAh: number;
};

const fails: string[] = [];
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name} ${detail}`);
  if (!cond) fails.push(name);
}

const errorLogsCaptured: string[] = [];
setOnErrorLog(args => errorLogsCaptured.push(args.map(argument => String(argument)).join(" ")));
process.on("unhandledRejection", reason => check("no unhandled promise rejection", false, String(reason)));
const hardTimeout = setTimeout(() => {
  console.error(`FAIL: socHistoryOutage run did not finish within ${HARD_TIMEOUT_MS} ms`);
  process.exit(1);
}, HARD_TIMEOUT_MS);

await checkBootWithInfluxDown();
await checkLiveAnchorDuringOutage();
clearTimeout(hardTimeout);
console.log(
  `\n${fails.length ? `${fails.length} FAILED: ${fails.join(", ")}` : "all socHistoryOutage selftests passed"}`
);
process.exit(fails.length ? 1 : 0);

async function checkBootWithInfluxDown(): Promise<void> {
  const port = await findClosedPort();
  const outageMonitor = createInfluxHistoryOutageMonitor(TEST_TIMING);
  const errorLogsBefore = errorLogsCaptured.length;
  const harness = startLedger(createTestClient(port), outageMonitor);
  const ledgerCreatedAtMonotonicMs = performance.now();

  const outageSamples = await feedConstantAmps(harness, OUTAGE_AMPS, 21, 100);
  check("A: nothing threw while InfluxDB was down", harness.ledgerErrors.length === 0, String(harness.ledgerErrors));
  check("A: SOC unknown while the history is unanswered", harness.ledger.socAh() === undefined);
  check("A: no anchor while the history is unanswered", harness.ledger.latestAnchor() === undefined);
  const episode = outageMonitor.currentEpisode();
  check(
    "A: the restore queries kept retrying (5 queries × several backoff rounds)",
    (episode?.failedAttempts ?? 0) >= 15,
    `${episode?.failedAttempts} failed attempts`
  );
  const escalations = errorLogsCaptured.slice(errorLogsBefore);
  check(
    "A: exactly one escalation errorLog once the outage passed escalateAfterMs",
    escalations.length === 1 && escalations[0]!.includes("InfluxDB history queries have failed"),
    JSON.stringify(escalations.map(text => text.slice(0, 90)))
  );

  const nowMs = Date.now();
  const history: FakeHistory = {
    fullMarkerAt: nowMs - 20 * HOUR_MS,
    softEmptyMarkerAt: nowMs - 5 * HOUR_MS,
    fullByVoltageAt: nowMs - 30 * HOUR_MS,
    emptyByVoltageAt: nowMs - 40 * HOUR_MS,
    chargeIntegralAh: 300,
  };
  const fakeInflux = await startFakeInflux(port, history);
  const socKnown = await waitFor(() => harness.ledger.socAh() !== undefined, 5_000);
  check("B: the SOC initialises once InfluxDB answers", socKnown);

  const anchor = harness.ledger.latestAnchor();
  check(
    "B: anchored on the newest kind (restored soft-empty), not an older fallback",
    anchor?.type === "soft_empty" && anchor.origin === "restored" && anchor.at === history.softEmptyMarkerAt,
    JSON.stringify(anchor)
  );
  const outageLocalAh = (OUTAGE_AMPS * (outageSamples.lastAtMonotonicMs - outageSamples.firstAtMonotonicMs)) / HOUR_MS;
  const expectedSoc = expectedSocFromSoftEmpty(history, history.chargeIntegralAh + outageLocalAh);
  const socWithoutOutageCharge = expectedSocFromSoftEmpty(history, history.chargeIntegralAh);
  const soc = harness.ledger.socAh() ?? NaN;
  check(
    "B: SOC = soft-empty anchor + DB integral to ledger start + the charge accumulated during the outage",
    Math.abs(soc - expectedSoc) < 0.005 && Math.abs(soc - socWithoutOutageCharge) > 1,
    `got ${soc.toFixed(3)} %, expected ${expectedSoc.toFixed(3)} % (${socWithoutOutageCharge.toFixed(3)} % if the outage's ${outageLocalAh.toFixed(1)} Ah were dropped)`
  );

  const restoreQueries = fakeInflux.queries.filter(query => !query.includes("integral("));
  const integralQuery = fakeInflux.queries.find(query => query.includes("integral("));
  const cutoffsMs = fakeInflux.queries.map(query => Number(/time < now\(\) - (\d+)ms/.exec(query)?.[1] ?? NaN));
  const msSinceLedgerCreated = performance.now() - ledgerCreatedAtMonotonicMs;
  check(
    "B: every answered query cuts the history at ledger start (offset from InfluxDB's own now())",
    cutoffsMs.length >= 6 &&
      cutoffsMs.every(cutoffMs => cutoffMs >= outageSamples.lastAtMonotonicMs - ledgerCreatedAtMonotonicMs - 50) &&
      cutoffsMs.every(cutoffMs => cutoffMs <= msSinceLedgerCreated + 50),
    `cutoffs ${cutoffsMs.join(", ")} ms, ledger running ${Math.round(msSinceLedgerCreated)} ms`
  );
  check(
    "B: the integral starts right after the anchor",
    !!integralQuery?.includes(`time >= ${history.softEmptyMarkerAt + 1}ms`),
    integralQuery
  );
  check("B: all five restore queries reached the fake InfluxDB", new Set(restoreQueries).size === 5);
  check("B: the outage episode ended with the answer", outageMonitor.currentEpisode() === undefined);
  check(
    "B: still only the one escalation after recovery",
    errorLogsCaptured.length - errorLogsBefore === 1,
    `${errorLogsCaptured.length - errorLogsBefore} errorLogs`
  );

  const socBeforeMoreSamples = harness.ledger.socAh() ?? NaN;
  await feedConstantAmps(harness, OUTAGE_AMPS, 6, 100);
  check(
    "B: live accumulation carries on after initialising",
    (harness.ledger.socAh() ?? NaN) > socBeforeMoreSamples + 0.5,
    `${socBeforeMoreSamples.toFixed(2)} % → ${harness.ledger.socAh()?.toFixed(2)} %`
  );
  check("B: nothing threw", harness.ledgerErrors.length === 0, String(harness.ledgerErrors));
  harness.dispose();
  await fakeInflux.close();
}

async function checkLiveAnchorDuringOutage(): Promise<void> {
  const port = await findClosedPort();
  const outageMonitor = createInfluxHistoryOutageMonitor({ ...TEST_TIMING, escalateAfterMs: 60_000 });
  const harness = startLedger(createTestClient(port), outageMonitor);
  await sleep(300);
  harness.setLastFullEventAt(Date.now());
  const socKnown = await waitFor(() => harness.ledger.socAh() !== undefined, 1_000);
  const soc = harness.ledger.socAh() ?? NaN;
  check(
    // Unclamped: the elapsed-drain term is a hair negative while useNow() still predates the event.
    "C: a live full during the outage gives a SOC (≈ 100 %) without InfluxDB",
    socKnown && Math.abs(soc - 100) < 0.01,
    `SOC ${soc}, anchor ${JSON.stringify(harness.ledger.latestAnchor())}`
  );
  check("C: the restore is still retrying in the background", outageMonitor.currentEpisode() !== undefined);

  harness.dispose();
  const attemptsAtDispose = outageMonitor.currentEpisode()?.failedAttempts;
  await sleep(TEST_TIMING.maxRetryDelayMs * 3);
  check(
    "C: disposing the root (a main() crash-restart) stops the retries",
    outageMonitor.currentEpisode()?.failedAttempts === attemptsAtDispose,
    `${attemptsAtDispose} → ${outageMonitor.currentEpisode()?.failedAttempts}`
  );
  check("C: nothing threw", harness.ledgerErrors.length === 0, String(harness.ledgerErrors));
}

function startLedger(client: Influx.InfluxDB, outageMonitor: InfluxHistoryOutageMonitor): LedgerHarness {
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
    return { ledger, ledgerErrors, setBatteryCurrentAmps, setLastFullEventAt, dispose };
  });
}

function createTestClient(port: number): Influx.InfluxDB {
  return new Influx.InfluxDB({
    host: "127.0.0.1",
    port,
    database: "selftest",
    username: "selftest",
    password: "selftest",
    pool: { backoff: NEVER_DISABLE_HOST, requestTimeout: 2_000 },
  });
}

/** Samples arrive synchronously into the ledger, so the monotonic times taken here bracket its own. */
async function feedConstantAmps(
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

function expectedSocFromSoftEmpty(history: FakeHistory, integralAh: number): number {
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
async function startFakeInflux(
  port: number,
  history: FakeHistory
): Promise<{ queries: string[]; close: () => Promise<void> }> {
  const queries: string[] = [];
  const server = http.createServer((request, response) => {
    const query = new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("q") ?? "";
    queries.push(query);
    const body = fakeInfluxAnswer(query, history);
    response.writeHead(body ? 200 : 400, { "content-type": "application/json" });
    response.end(JSON.stringify(body ?? { error: `selftest fake InfluxDB has no answer for: ${query}` }));
  });
  await new Promise<void>(resolve => server.listen(port, "127.0.0.1", resolve));
  return { queries, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

function fakeInfluxAnswer(query: string, history: FakeHistory) {
  if (query.includes("integral(")) return seriesAnswer("current_values", "charge", 0, history.chargeIntegralAh);
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

/** A port nothing listens on (bound once to learn a free one, then released). */
async function findClosedPort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  await new Promise<void>(resolve => probe.close(() => resolve()));
  if (!address || typeof address === "string") throw new Error("could not determine a free local port");
  return address.port;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(25);
  }
  return predicate();
}

function sleep(durationMs: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, durationMs));
}
