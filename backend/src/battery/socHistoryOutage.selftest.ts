/**
 * Integration self-test of the Ah ledger booting while InfluxDB is down (the 2026-10-23 power cycle).
 * useAhLedger runs for real against a node-influx client pointed at a closed local port, then a fake
 * InfluxDB comes up on that port with canned history (socHistoryOutageHarness.ts):
 *
 *  A. while down: nothing throws, the history queries keep retrying, the SOC and anchor stay unknown, and
 *     the outage escalates with exactly one errorLog;
 *  B. once it answers: the SOC initialises from the right (newest) anchor, the queries cut the history at
 *     ledger start, and the charge accumulated during the outage is part of the SOC; a live full anchor
 *     afterwards hands exactly that span to parameter tracking and restarts the local count;
 *  C. a live anchor during an outage gives a SOC without InfluxDB (dropping what was counted before it),
 *     and disposing the root (what every main() crash-restart does) stops the retries.
 *
 * Restarts on one monitor and episodes that go quiet: socHistoryOutageRestart.selftest.ts.
 * Run from backend/ with:  yarn node src/battery/socHistoryOutage.selftest.ts   (~6 s)
 */
import process from "process";
import { default_config } from "../config/config.ts";
import { setOnErrorLog } from "../utilities/logging.ts";
import { computeParameterUpdates } from "./ahLedgerMath.ts";
import { createInfluxHistoryOutageMonitor } from "./influxHistoryOutage.ts";
import {
  constantAmpsAh,
  createTestClient,
  expectedSocFromSoftEmpty,
  feedConstantAmps,
  findClosedPort,
  historyEndingAt,
  HOUR_MS,
  OUTAGE_AMPS,
  sleep,
  startFakeInflux,
  startLedger,
  TEST_TIMING,
  waitFor,
} from "./socHistoryOutageHarness.ts";

const HARD_TIMEOUT_MS = 60_000;

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

  // Charged from soft-empty to nearly full meanwhile, so the live full below is a believable capacity span.
  const history = historyEndingAt(Date.now(), 1200);
  const fakeInflux = await startFakeInflux(port, history);
  const socKnown = await waitFor(() => harness.ledger.socAh() !== undefined, 5_000);
  check("B: the SOC initialises once InfluxDB answers", socKnown);

  const anchor = harness.ledger.latestAnchor();
  check(
    "B: anchored on the newest kind (restored soft-empty), not an older fallback",
    anchor?.type === "soft_empty" && anchor.origin === "restored" && anchor.at === history.softEmptyMarkerAt,
    JSON.stringify(anchor)
  );
  const outageLocalAh = constantAmpsAh(OUTAGE_AMPS, outageSamples.firstAtMonotonicMs, outageSamples.lastAtMonotonicMs);
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

  const socBeforeMoreSamples = harness.ledger.socAh() ?? NaN;
  const laterSamples = await feedConstantAmps(harness, OUTAGE_AMPS, 6, 100);
  check(
    "B: live accumulation carries on after initialising",
    (harness.ledger.socAh() ?? NaN) > socBeforeMoreSamples + 0.5,
    `${socBeforeMoreSamples.toFixed(2)} % → ${harness.ledger.socAh()?.toFixed(2)} %`
  );

  // Restored → live: the span handed to tracking is DB share + everything counted locally since start.
  const { drain_a, capacity_ah, drain_ema_tau_days, soft_empty } = default_config.soc_calculations.ah_ledger;
  const spanIntegralAh =
    history.chargeIntegralAh +
    constantAmpsAh(OUTAGE_AMPS, outageSamples.firstAtMonotonicMs, laterSamples.lastAtMonotonicMs);
  const liveFullAt = Date.now();
  harness.setLastFullEventAt(liveFullAt);
  const expectedTracking = computeParameterUpdates({
    prevType: "soft_empty",
    nextType: "full",
    prevSoc: soft_empty.soc_percent,
    nextSoc: 100,
    dtHours: (liveFullAt - history.softEmptyMarkerAt) / HOUR_MS,
    spanIntegralAh,
    currentDrainA: drain_a,
    currentCapacityAh: capacity_ah,
    drainEmaTauDays: drain_ema_tau_days,
  });
  const trackedCapacityAh = harness.config().soc_calculations.ah_ledger.capacity_ah;
  check(
    "B→live: parameter tracking got the restored span (DB share + outage + later local charge)",
    expectedTracking.capacityAh !== undefined && Math.abs(trackedCapacityAh - expectedTracking.capacityAh) < 0.01,
    `capacity ${capacity_ah} → ${trackedCapacityAh.toFixed(2)} Ah, expected ${expectedTracking.capacityAh?.toFixed(2)} (span ${spanIntegralAh.toFixed(1)} Ah)`
  );
  await waitFor(() => harness.ledger.latestAnchor()?.origin === "live" && harness.ledger.socAh() !== undefined, 1_000);
  const socAfterLiveFull = harness.ledger.socAh() ?? NaN;
  check(
    "B→live: the live full re-pins the SOC at ≈ 100 % (local count restarted, no DB share)",
    Math.abs(socAfterLiveFull - 100) < 0.01,
    `${socAfterLiveFull} %`
  );
  check(
    "B: still only the one escalation (and no rejected tracking estimate)",
    errorLogsCaptured.length - errorLogsBefore === 1,
    JSON.stringify(errorLogsCaptured.slice(errorLogsBefore + 1).map(text => text.slice(0, 90)))
  );
  check("B: nothing threw", harness.ledgerErrors.length === 0, String(harness.ledgerErrors));
  harness.dispose();
  await fakeInflux.close();
}

async function checkLiveAnchorDuringOutage(): Promise<void> {
  const port = await findClosedPort();
  const outageMonitor = createInfluxHistoryOutageMonitor({ ...TEST_TIMING, escalateAfterMs: 60_000 });
  const harness = startLedger(createTestClient(port), outageMonitor);
  // Charge counted before the anchor must not survive it: without the reset this lands ≈ +0.3 pp on top.
  await feedConstantAmps(harness, OUTAGE_AMPS, 5, 50);
  harness.setLastFullEventAt(Date.now());
  const socKnown = await waitFor(() => harness.ledger.socAh() !== undefined, 1_000);
  const soc = harness.ledger.socAh() ?? NaN;
  check(
    // Unclamped: the elapsed-drain term is a hair negative while useNow() still predates the event.
    "C: a live full during the outage gives a SOC of ≈ 100 % without InfluxDB, pre-anchor charge dropped",
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
