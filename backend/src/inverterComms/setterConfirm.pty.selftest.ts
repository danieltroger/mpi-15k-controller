/**
 * End-to-end self-test of the write → confirm path (#52): the real engine against fakePi17Inverter.py
 * on a pty, polling continuing through every write, in two inverter behaviours.
 *
 *  A. Slow commit: every write commits 2.5 s after it arrives, whatever the traffic. GS/PS polling
 *     must carry on through the write, the confirms must see the old value first and then converge,
 *     and the commit timing line must say so.
 *  B. Starved commit (the July 2026 hypothesis #52 ruled out for the real inverter): a write commits
 *     only once no command has arrived for 2 s, so with polling it never does. The session must give
 *     up loudly at the deadline with the one errorLog behind the P2, and keep polling.
 *  C. The same starved inverter, the field retargeted every ~1.5 s (#75's review: the buy current
 *     under continuous polling): every check is superseded before its give-up, yet the session pages
 *     the field once, from a readback past the starved-write threshold.
 *
 * The windows are scaled down for the harness (first confirm 1 s after the write, then every 1 s,
 * give-up after 6 s, starved after 7 s). The production numbers are in schedulerTiming.ts. The commit timing lines
 * are this test's readout, read from the log the way #52's run read them.
 *
 * Run from backend/ with:  yarn node src/inverterComms/setterConfirm.pty.selftest.ts
 * Needs python3 and Linux ptys. Takes ~20 s.
 */
import process from "process";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "child_process";
import readline from "readline";
import { fileURLToPath } from "url";
import { createRoot } from "solid-js";
import { createInverterSession } from "./inverterSession.ts";
import type { DecodedRound } from "./pi17Protocol.types.ts";
import type { CommitTimingRecord } from "./setterCommitTiming.ts";
import type { SchedulerTiming } from "./schedulerTiming.ts";
import { setOnErrorLog } from "../utilities/logging.ts";

const FAKE_INVERTER_SCRIPT = fileURLToPath(new URL("./fakePi17Inverter.py", import.meta.url));
const HARD_TIMEOUT_MS = 90_000;
const SLOW_COMMIT_DELAY_S = 2.5;
const COMMIT_NEEDS_QUIET_S = 2;
const HARNESS_TIMING: Partial<SchedulerTiming> = {
  firstConfirmAfterWriteMs: 1_000,
  confirmRecheckIntervalMs: 1_000,
  confirmGiveUpAfterWriteMs: 6_000,
  starvedWritePageAfterMs: 7_000,
};
/** Scenario C's targets, one every ~1.5 s, all different from the fake's boot 350 W and from each other */
const RETARGETED_GPMP_WATTS = [400, 410, 420, 430, 440, 450, 460, 470];
/** Polling "continues" if no two GS rounds are further apart than a round plus a confirm and slack */
const MAX_GS_GAP_WHILE_POLLING_MS = 2_000;

type FakeInverterEvent =
  | { event: "ready"; device: string }
  | { event: "received"; command: string }
  | { event: "committed"; setter: string }
  | { event: "summary"; pending_commits: string[]; commits_deferred_by_traffic: number }
  | { event: "frame_sent" | "fault" | "faults_done" | "lost" | "garbage" };

const fails: string[] = [];
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name} ${detail}`);
  if (!cond) fails.push(name);
}

const errorLogsCaptured: string[] = [];
/** When each captured errorLog was logged (wall clock), in the same order */
const errorLogTimes: number[] = [];
setOnErrorLog(args => {
  errorLogsCaptured.push(args.map(argument => String(argument)).join(" "));
  errorLogTimes.push(Date.now());
});
const commitTimingRecords: CommitTimingRecord[] = [];
captureCommitTimingLines(commitTimingRecords);
const hardTimeout = setTimeout(() => {
  console.error(`FAIL: setter confirm run did not finish within ${HARD_TIMEOUT_MS} ms`);
  process.exit(1);
}, HARD_TIMEOUT_MS);

await runSetterConfirmChecks();
clearTimeout(hardTimeout);
console.log(
  `\n${fails.length ? `${fails.length} FAILED: ${fails.join(", ")}` : "all setterConfirm pty selftests passed"}`
);
process.exit(fails.length ? 1 : 0);

async function runSetterConfirmChecks(): Promise<void> {
  const python = spawnSync("python3", ["--version"], { encoding: "utf-8" });
  if (python.status !== 0) {
    check("python3 is available for the fake inverter", false, String(python.error ?? python.stderr));
    return;
  }
  await checkSlowCommitWithPollingContinuing();
  await checkStarvedCommitGivesUpLoudly();
  await checkRetargetedStarvedFieldPagesOnce();
}

async function checkRetargetedStarvedFieldPagesOnce(): Promise<void> {
  const fake = await startFakeInverter(["--no-faults", "--commit-needs-quiet-s", String(COMMIT_NEEDS_QUIET_S)]);
  const engine = startEngine(fake.device);
  await waitFor(() => roundsOf(engine.decodedRounds, "GS").length >= 3, 10_000);
  const errorLogsBefore = errorLogsCaptured.length;
  const firstWrite = await writeAndAwaitAck(engine.session, gpmpCommand(RETARGETED_GPMP_WATTS[0]!));
  for (const watts of RETARGETED_GPMP_WATTS.slice(1)) {
    await sleep(1_500);
    await writeAndAwaitAck(engine.session, gpmpCommand(watts));
  }
  await waitFor(() => errorLogsCaptured.length > errorLogsBefore, 6_000);
  const pagedAt = errorLogTimes[errorLogsBefore] ?? Date.now();
  // Past the last write's own 6 s give-up, which must not page a second time
  await sleep(8_000);
  const counters = engine.session.exchangeCounters();
  engine.dispose();
  await fake.stop();
  const pages = errorLogsCaptured.slice(errorLogsBefore);
  check(
    "C: the retargeted starved field paged once, 7–10 s after its first ACK — as never applied, naming GPMP",
    pages.length === 1 &&
      pages[0]!.startsWith("Inverter never applied ACKed writes to GPMP maximum_feeding_grid_power:") &&
      firstWrite.ackedAt !== undefined &&
      pagedAt - firstWrite.ackedAt >= 7_000 &&
      pagedAt - firstWrite.ackedAt <= 10_000,
    `${pages.length} errorLog(s) ${firstWrite.ackedAt === undefined ? "" : `${pagedAt - firstWrite.ackedAt} ms after the first ACK`}: ${pages.join(" | ")}`
  );
  check(
    "C: the last write's give-up landed inside the same episode — logged, not paged",
    counters.writesNeverApplied >= 1,
    `never applied ${counters.writesNeverApplied}, confirmed ${counters.writesConfirmed}`
  );
}

function gpmpCommand(watts: number): `GPMP0${string}` {
  return `GPMP0${String(watts).padStart(5, "0")}`;
}

async function checkSlowCommitWithPollingContinuing(): Promise<void> {
  const fake = await startFakeInverter(["--no-faults", "--commit-delay-s", String(SLOW_COMMIT_DELAY_S)]);
  const engine = startEngine(fake.device);
  await waitFor(() => roundsOf(engine.decodedRounds, "GS").length >= 3, 10_000);
  const errorLogsBefore = errorLogsCaptured.length;

  const write = await writeAndAwaitAck(engine.session, "GPMP000550");
  const ackedAt = write.ackedAt;
  const record = await waitForTimingRecord(write, "GPMP000550", 10_000);
  const verdictAt = Date.now();
  const counters = engine.session.exchangeCounters();
  engine.dispose();
  const fakeEvents = await fake.stop();

  check("A: GPMP000550 was ACKed", ackedAt !== undefined);
  check("A: its commit timing line says confirmed", record?.verdict === "confirmed", JSON.stringify(record));
  check(
    `A: ACK → confirmed spans the ${SLOW_COMMIT_DELAY_S} s commit delay plus at most ~2 confirm intervals`,
    record !== undefined && record.ackToVerdictMs >= SLOW_COMMIT_DELAY_S * 1000 - 200 && record.ackToVerdictMs <= 5_000,
    `${record?.ackToVerdictMs} ms`
  );
  check(
    "A: a confirm saw the old value before the commit landed",
    record !== undefined &&
      record.readbacksStillOld >= 1 &&
      record.lastStillOldAfterAckMs !== null &&
      // The fake's commit time counts from the setter's arrival, the engine's from the ACK and
      // the readback's decode — 300 ms of headroom for a slow runner
      record.lastStillOldAfterAckMs < SLOW_COMMIT_DELAY_S * 1000 + 300,
    `${record?.readbacksStillOld} still-old readback(s), the last at ${record?.lastStillOldAfterAckMs} ms`
  );
  check(
    "A: GS/PS poll rounds kept running between the ACK and the confirmation",
    record !== undefined && record.pollRoundsBetween >= 2,
    `${record?.pollRoundsBetween} rounds, ${record?.framesBetween} frames`
  );
  const gsTimesDuringPhase = roundsOf(engine.decodedRounds, "GS")
    .map(round => round.decodedAt)
    .filter(decodedAt => ackedAt !== undefined && decodedAt >= ackedAt - 1_500 && decodedAt <= verdictAt + 1_500);
  check(
    `A: no GS gap over ${MAX_GS_GAP_WHILE_POLLING_MS} ms around the write (no radio silence)`,
    gsTimesDuringPhase.length >= 3 && longestGap(gsTimesDuringPhase) <= MAX_GS_GAP_WHILE_POLLING_MS,
    `${gsTimesDuringPhase.length} GS rounds, longest gap ${longestGap(gsTimesDuringPhase)} ms`
  );
  const gpmpWattsAfterAck = roundsOf(engine.decodedRounds, "GPMP")
    .filter(round => ackedAt !== undefined && round.decodedAt >= ackedAt)
    .map(round => round.fields.maximum_feeding_grid_power);
  check(
    "A: the GPMP readbacks after the ACK go 350 → 550",
    gpmpWattsAfterAck[0] === 350 && gpmpWattsAfterAck.at(-1) === 550,
    gpmpWattsAfterAck.join(" → ")
  );
  check(
    "A: the fake received GS/PS queries between the setter and its commit (traffic continued)",
    queriesBetweenSetterAndCommit(fakeEvents, "GPMP000550") >= 2,
    `${queriesBetweenSetterAndCommit(fakeEvents, "GPMP000550")} queries`
  );
  check(
    "A: counted as confirmed, nothing errorLogged",
    counters.writesConfirmed === 1 && counters.writesNeverApplied === 0 && errorLogsCaptured.length === errorLogsBefore,
    errorLogsCaptured.slice(errorLogsBefore).join(" | ")
  );
}

async function checkStarvedCommitGivesUpLoudly(): Promise<void> {
  const fake = await startFakeInverter(["--no-faults", "--commit-needs-quiet-s", String(COMMIT_NEEDS_QUIET_S)]);
  const engine = startEngine(fake.device);
  await waitFor(() => roundsOf(engine.decodedRounds, "GS").length >= 3, 10_000);
  const errorLogsBefore = errorLogsCaptured.length;

  const starvedWrite = await writeAndAwaitAck(engine.session, "GPMP000550");
  const starvedAckedAt = starvedWrite.ackedAt;
  const starvedRecord = await waitForTimingRecord(starvedWrite, "GPMP000550", 12_000);
  const gaveUpAt = Date.now();
  await sleep(2_500);
  const gsAfterGiveUp = roundsOf(engine.decodedRounds, "GS").filter(round => round.decodedAt > gaveUpAt);
  const gsDuringPhase = roundsOf(engine.decodedRounds, "GS")
    .map(round => round.decodedAt)
    .filter(decodedAt => starvedAckedAt !== undefined && decodedAt >= starvedAckedAt && decodedAt <= gaveUpAt);
  const counters = engine.session.exchangeCounters();
  engine.dispose();
  const fakeEvents = await fake.stop();
  const summary = fakeEvents.find(event => event.event === "summary");

  check(
    "B: the starved write is given up as never_applied at the deadline",
    starvedRecord?.verdict === "never_applied" &&
      starvedRecord.ackToVerdictMs >= 5_900 &&
      starvedRecord.ackToVerdictMs <= 8_500 &&
      starvedRecord.readbacksStillOld >= 3,
    JSON.stringify(starvedRecord)
  );
  const neverAppliedErrorLogs = errorLogsCaptured
    .slice(errorLogsBefore)
    .filter(text => text.includes("never applied") && text.includes("GPMP000550"));
  check(
    "B: the give-up errorLogged (P2) exactly once, and nothing else — no fallback, no second page",
    neverAppliedErrorLogs.length === 1 && errorLogsCaptured.length - errorLogsBefore === 1,
    errorLogsCaptured.slice(errorLogsBefore).join(" | ")
  );
  check(
    "B: polling continued through the starved write's confirm phase and after the give-up",
    gsDuringPhase.length >= 4 && longestGap(gsDuringPhase) <= MAX_GS_GAP_WHILE_POLLING_MS && gsAfterGiveUp.length >= 1,
    `${gsDuringPhase.length} GS rounds in the phase (longest gap ${longestGap(gsDuringPhase)} ms), ${gsAfterGiveUp.length} after`
  );
  check(
    "B: the fake never committed it — polling kept deferring the commit",
    summary?.event === "summary" &&
      summary.pending_commits.length === 1 &&
      summary.commits_deferred_by_traffic >= 3 &&
      !fakeEvents.some(event => event.event === "committed"),
    JSON.stringify(summary)
  );
  check(
    "B: counted as one never-applied write",
    counters.writesConfirmed === 0 && counters.writesNeverApplied === 1,
    `confirmed ${counters.writesConfirmed}, never applied ${counters.writesNeverApplied}`
  );
}

function startEngine(device: string) {
  const decodedRounds: DecodedRound[] = [];
  let session: ReturnType<typeof createInverterSession> | undefined;
  const dispose = createRoot(disposeRoot => {
    session = createInverterSession({
      devicePath: device,
      // Only the boot round reads the settings: every later GPMP readback is a confirm
      poll_values_interval_seconds: () => 600,
      onDecodedRound: round => decodedRounds.push(round),
      schedulerTimingOverrides: HARNESS_TIMING,
    });
    return disposeRoot;
  });
  if (!session) throw new Error("createInverterSession returned nothing");
  return { session, decodedRounds, dispose };
}

/**
 * Queue the write; resolves with the wall-clock time of its ACK (undefined if none came within
 * 5 s) and the number of commit timing records logged before it, so only its own count.
 */
async function writeAndAwaitAck(
  session: ReturnType<typeof createInverterSession>,
  command: `GPMP0${string}`
): Promise<{ ackedAt: number | undefined; recordsBefore: number }> {
  const recordsBefore = commitTimingRecords.length;
  let ackedAt: number | undefined;
  session.queueSetter({
    command,
    replacesPrefix: "GPMP0",
    refreshAfterSend: ["GPMP"],
    onResult: ({ acknowledged }) => {
      if (acknowledged) ackedAt = Date.now();
    },
  });
  await waitFor(() => ackedAt !== undefined, 5_000);
  return { ackedAt, recordsBefore };
}

async function waitForTimingRecord(
  write: { recordsBefore: number },
  command: string,
  timeoutMs: number
): Promise<CommitTimingRecord | undefined> {
  await waitFor(() => timingRecordLoggedSince(write.recordsBefore, command) !== undefined, timeoutMs);
  return timingRecordLoggedSince(write.recordsBefore, command);
}

/** The first commit timing record for `command` among those logged after the first `recordsBefore` */
function timingRecordLoggedSince(recordsBefore: number, command: string): CommitTimingRecord | undefined {
  return commitTimingRecords.slice(recordsBefore).find(record => record.command === command);
}

/** GS/PS queries the fake received after the setter and before its commit */
function queriesBetweenSetterAndCommit(events: readonly FakeInverterEvent[], setter: string): number {
  const setterIndex = events.findIndex(event => event.event === "received" && event.command === `^S011${setter}`);
  const commitIndex = events.findIndex(event => event.event === "committed" && event.setter === setter);
  if (setterIndex === -1 || commitIndex === -1) return 0;
  return events
    .slice(setterIndex, commitIndex)
    .filter(event => event.event === "received" && /^\^P00[34](GS|PS)$/.test(event.command)).length;
}

function roundsOf(rounds: readonly DecodedRound[], command: DecodedRound["command"]): DecodedRound[] {
  return rounds.filter(round => round.command === command);
}

function longestGap(times: readonly number[]): number {
  return Math.max(0, ...times.slice(1).map((time, index) => time - times[index]!));
}

/** Tees console.log, keeping each "Inverter commit timing:" line's record */
function captureCommitTimingLines(into: CommitTimingRecord[]): void {
  const printToConsole = console.log.bind(console);
  console.log = (...args: unknown[]) => {
    const labelIndex = args.indexOf("Inverter commit timing:");
    // Our own logLog output: the label is followed by the record's JSON
    if (labelIndex !== -1) into.push(JSON.parse(String(args[labelIndex + 1])) as CommitTimingRecord);
    printToConsole(...args);
  };
}

async function startFakeInverter(fakeArguments: readonly string[]): Promise<{
  device: string;
  /** Live: grows as the fake reports */
  events: readonly FakeInverterEvent[];
  stop: () => Promise<readonly FakeInverterEvent[]>;
}> {
  const child: ChildProcessWithoutNullStreams = spawn("python3", ["-I", FAKE_INVERTER_SCRIPT, ...fakeArguments], {
    stdio: "pipe",
  });
  child.stderr.on("data", (chunk: Buffer) => process.stderr.write(`[fake inverter] ${chunk.toString()}`));
  const events: FakeInverterEvent[] = [];
  const exited = new Promise<void>(resolve => child.on("exit", () => resolve()));
  const device = await new Promise<string>(resolve =>
    readline.createInterface({ input: child.stdout }).on("line", line => {
      // Trusted harness output, one JSON object per line in the shape documented in the .py file
      const event = JSON.parse(line) as FakeInverterEvent;
      events.push(event);
      if (event.event === "ready") resolve(event.device);
    })
  );
  return {
    device,
    events,
    stop: async () => {
      child.stdin.end(); // EOF on its stdin makes it print the summary and exit
      await exited;
      return events;
    },
  };
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) await sleep(20);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}
