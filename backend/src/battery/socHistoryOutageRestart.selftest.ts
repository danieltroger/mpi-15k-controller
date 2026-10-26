/**
 * Integration self-test of the outage monitor across ledger lifetimes, with the real useAhLedger and a
 * node-influx client on a local port (socHistoryOutageHarness.ts):
 *
 *  D. a main() crash-restart mid-outage: the new ledger reports into the same episode, so the outage still
 *     escalates exactly once; an episode left escalated by a dead ledger doesn't swallow the next outage;
 *     and once InfluxDB answers, the restarted ledger initialises;
 *  E. the restore answers but the charge integral keeps failing, then a live anchor cancels it: the
 *     episode goes quiet and closes without the false "SOC can't be restored" P2.
 *
 * Run from backend/ with:  yarn node src/battery/socHistoryOutageRestart.selftest.ts   (~9 s)
 */
import process from "process";
import { setOnErrorLog } from "../utilities/logging.ts";
import { createInfluxHistoryOutageMonitor } from "./influxHistoryOutage.ts";
import {
  createTestClient,
  findClosedPort,
  historyEndingAt,
  sleep,
  startFakeInflux,
  startLedger,
  TEST_TIMING,
  waitFor,
} from "./socHistoryOutageHarness.ts";

const HARD_TIMEOUT_MS = 60_000;
// How long an episode's failures may pause before it counts as over (historyRetryPolicy.ts).
const QUIET_AFTER_MS = 2 * (TEST_TIMING.maxRetryDelayMs + TEST_TIMING.requestTimeoutMs);

const fails: string[] = [];
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name} ${detail}`);
  if (!cond) fails.push(name);
}

const errorLogsCaptured: string[] = [];
setOnErrorLog(args => errorLogsCaptured.push(args.map(argument => String(argument)).join(" ")));
process.on("unhandledRejection", reason => check("no unhandled promise rejection", false, String(reason)));
const hardTimeout = setTimeout(() => {
  console.error(`FAIL: socHistoryOutageRestart run did not finish within ${HARD_TIMEOUT_MS} ms`);
  process.exit(1);
}, HARD_TIMEOUT_MS);

await checkRestartMidOutage();
await checkCancelledIntegralGoesQuiet();
clearTimeout(hardTimeout);
console.log(
  `\n${fails.length ? `${fails.length} FAILED: ${fails.join(", ")}` : "all socHistoryOutageRestart selftests passed"}`
);
process.exit(fails.length ? 1 : 0);

async function checkRestartMidOutage(): Promise<void> {
  const port = await findClosedPort();
  const outageMonitor = createInfluxHistoryOutageMonitor(TEST_TIMING);
  const errorLogsBefore = errorLogsCaptured.length;
  const escalationsSoFar = () =>
    errorLogsCaptured.slice(errorLogsBefore).filter(text => text.includes("InfluxDB history queries have failed"));

  const firstLedger = startLedger(createTestClient(port), outageMonitor);
  await sleep(700);
  const episodeBeforeRestart = outageMonitor.currentEpisode();
  firstLedger.dispose();
  await sleep(200); // index.ts waits before restarting main(); shortened
  const restartedLedger = startLedger(createTestClient(port), outageMonitor);
  await sleep(TEST_TIMING.escalateAfterMs);
  const episodeAfterRestart = outageMonitor.currentEpisode();
  check(
    "D: the restarted ledger reports into the same episode",
    !!episodeBeforeRestart &&
      episodeAfterRestart?.startedAtMs === episodeBeforeRestart.startedAtMs &&
      episodeAfterRestart.failedAttempts > episodeBeforeRestart.failedAttempts,
    `${episodeBeforeRestart?.failedAttempts} → ${episodeAfterRestart?.failedAttempts} attempts`
  );
  check(
    "D: exactly one escalation across the restart",
    escalationsSoFar().length === 1 && !!episodeAfterRestart?.escalated,
    `${escalationsSoFar().length} escalations`
  );

  // The restarted ledger dies too and nothing queries for a while: that escalated episode is stale now.
  restartedLedger.dispose();
  await sleep(QUIET_AFTER_MS + 200);
  const thirdLedger = startLedger(createTestClient(port), outageMonitor);
  await sleep(300);
  const freshEpisode = outageMonitor.currentEpisode();
  check(
    "D: the next outage opens a fresh episode instead of joining the stale escalated one",
    !!freshEpisode && freshEpisode.startedAtMs !== episodeAfterRestart?.startedAtMs && !freshEpisode.escalated,
    JSON.stringify(freshEpisode)
  );
  await sleep(TEST_TIMING.escalateAfterMs);
  check("D: … and pages on its own", escalationsSoFar().length === 2, `${escalationsSoFar().length} escalations`);

  const fakeInflux = await startFakeInflux(port, historyEndingAt(Date.now(), 300));
  const socKnown = await waitFor(() => thirdLedger.ledger.socAh() !== undefined, 5_000);
  check("D: the restarted ledger initialises once InfluxDB answers", socKnown, `${thirdLedger.ledger.socAh()} %`);
  check("D: the episode ended with the answer", outageMonitor.currentEpisode() === undefined);
  check(
    "D: nothing threw in any of the three ledgers",
    [firstLedger, restartedLedger, thirdLedger].every(harness => harness.ledgerErrors.length === 0)
  );
  thirdLedger.dispose();
  await fakeInflux.close();
}

async function checkCancelledIntegralGoesQuiet(): Promise<void> {
  const port = await findClosedPort();
  const escalateAfterMs = QUIET_AFTER_MS + 1_200;
  const outageMonitor = createInfluxHistoryOutageMonitor({ ...TEST_TIMING, escalateAfterMs });
  const errorLogsBefore = errorLogsCaptured.length;
  const fakeInflux = await startFakeInflux(port, { ...historyEndingAt(Date.now(), 300), failChargeIntegral: true });
  const harness = startLedger(createTestClient(port), outageMonitor);

  const integralFailing = await waitFor(() => (outageMonitor.currentEpisode()?.failedAttempts ?? 0) >= 3, 3_000);
  check(
    "E: the restore answered but the charge integral keeps failing (SOC unknown, episode open)",
    integralFailing && harness.ledger.latestAnchor()?.origin === "restored" && harness.ledger.socAh() === undefined,
    `${outageMonitor.currentEpisode()?.failedAttempts} failed attempts`
  );
  const episodeStartedAtMs = outageMonitor.currentEpisode()?.startedAtMs ?? performance.now();
  harness.setLastFullEventAt(Date.now());
  const socKnown = await waitFor(() => harness.ledger.socAh() !== undefined, 1_000);
  check("E: a live full cancels the integral and gives a SOC", socKnown, `${harness.ledger.socAh()} %`);

  await sleep(Math.max(0, episodeStartedAtMs + escalateAfterMs + 300 - performance.now()));
  check(
    "E: past the escalation time the quiet episode closed instead",
    outageMonitor.currentEpisode() === undefined,
    JSON.stringify(outageMonitor.currentEpisode())
  );
  check(
    'E: no false "SOC can\'t be restored" P2',
    errorLogsCaptured.length === errorLogsBefore,
    JSON.stringify(errorLogsCaptured.slice(errorLogsBefore).map(text => text.slice(0, 90)))
  );
  check("E: nothing threw", harness.ledgerErrors.length === 0, String(harness.ledgerErrors));
  harness.dispose();
  await fakeInflux.close();
}
