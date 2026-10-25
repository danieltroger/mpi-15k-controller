/**
 * End-to-end self-test of the quiet-gap knob (#52): the real engine against fakePi17Inverter.py on
 * a pty, in the two inverter behaviours the July 2026 evidence can't tell apart.
 *
 *  A. Slow commit: every write commits 2.5 s after it arrives, whatever the traffic. With the gap
 *     at 0, GS/PS polling must carry on through the write, interleaved confirms must see the old
 *     value first and then converge, and the commit timing line must say so.
 *  B. Starved commit: a write commits only once no command has arrived for 2 s. With a 3 s gap (the
 *     silent strategy) the write converges. Switched live to 0, the next write never commits while
 *     polling continues, and the session must give up loudly with the errorLog behind the P2.
 *
 * The windows are scaled down for the harness (first confirm 1 s after the write, then every 1 s,
 * give-up after 6 s). The production numbers are in schedulerTiming.ts. The commit timing lines
 * are this test's readout, read from the log the way the experiment runbook reads them.
 *
 * Run from backend/ with:  yarn node src/inverterComms/quietGapExperiment.pty.selftest.ts
 * Needs python3 and Linux ptys. Takes ~30 s.
 */
import process from "process";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "child_process";
import readline from "readline";
import { fileURLToPath } from "url";
import { createRoot, createSignal, type Accessor } from "solid-js";
import { createInverterSession } from "./inverterSession.ts";
import type { DecodedRound } from "./pi17Protocol.types.ts";
import type { CommitTimingRecord } from "./setterCommitTiming.ts";
import type { SchedulerTiming } from "./schedulerTiming.ts";
import { setOnErrorLog } from "../utilities/logging.ts";

const FAKE_INVERTER_SCRIPT = fileURLToPath(new URL("./fakePi17Inverter.py", import.meta.url));
const HARD_TIMEOUT_MS = 90_000;
const SLOW_COMMIT_DELAY_S = 2.5;
const COMMIT_NEEDS_QUIET_S = 2;
const SILENT_QUIET_GAP_MS = 3_000;
const HARNESS_TIMING: Partial<Omit<SchedulerTiming, "quietGapAfterWriteMs">> = {
  firstInterleavedConfirmAfterWriteMs: 1_000,
  interleavedConfirmIntervalMs: 1_000,
  interleavedConfirmGiveUpAfterWriteMs: 6_000,
  confirmBackoffMs: 3_000,
};
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
setOnErrorLog(args => errorLogsCaptured.push(args.map(argument => String(argument)).join(" ")));
const commitTimingRecords: CommitTimingRecord[] = [];
captureCommitTimingLines(commitTimingRecords);
const hardTimeout = setTimeout(() => {
  console.error(`FAIL: quiet-gap run did not finish within ${HARD_TIMEOUT_MS} ms`);
  process.exit(1);
}, HARD_TIMEOUT_MS);

await runQuietGapChecks();
clearTimeout(hardTimeout);
console.log(
  `\n${fails.length ? `${fails.length} FAILED: ${fails.join(", ")}` : "all quietGapExperiment pty selftests passed"}`
);
process.exit(fails.length ? 1 : 0);

async function runQuietGapChecks(): Promise<void> {
  const python = spawnSync("python3", ["--version"], { encoding: "utf-8" });
  if (python.status !== 0) {
    check("python3 is available for the fake inverter", false, String(python.error ?? python.stderr));
    return;
  }
  await checkSlowCommitWithPollingContinuing();
  await checkStarvedCommitGivesUpLoudly();
}

async function checkSlowCommitWithPollingContinuing(): Promise<void> {
  const fake = await startFakeInverter(["--no-faults", "--commit-delay-s", String(SLOW_COMMIT_DELAY_S)]);
  const engine = startEngine(fake.device, () => 0);
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
  check(
    "A: its commit timing line says confirmed, with the gap at 0",
    record?.verdict === "confirmed" && record.quietGapAfterWriteMs === 0,
    JSON.stringify(record)
  );
  check(
    `A: ACK → confirmed spans the ${SLOW_COMMIT_DELAY_S} s commit delay plus at most ~2 confirm intervals`,
    record !== undefined && record.ackToVerdictMs >= SLOW_COMMIT_DELAY_S * 1000 - 200 && record.ackToVerdictMs <= 5_000,
    `${record?.ackToVerdictMs} ms`
  );
  check(
    "A: an interleaved confirm saw the old value before the commit landed",
    record !== undefined &&
      record.readbacksStillOld >= 1 &&
      record.lastStillOldAfterAckMs !== null &&
      record.lastStillOldAfterAckMs < SLOW_COMMIT_DELAY_S * 1000,
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
  const [quietGapMs, setQuietGapMs] = createSignal(SILENT_QUIET_GAP_MS);
  const engine = startEngine(fake.device, quietGapMs);
  await waitFor(() => roundsOf(engine.decodedRounds, "GS").length >= 3, 10_000);
  const errorLogsBefore = errorLogsCaptured.length;

  const silentWrite = await writeAndAwaitAck(engine.session, "GPMP000550");
  const silentAckedAt = silentWrite.ackedAt;
  const silentRecord = await waitForTimingRecord(silentWrite, "GPMP000550", 10_000);
  check(
    `B: with a ${SILENT_QUIET_GAP_MS} ms gap the starved write commits during the silence and is confirmed`,
    silentRecord?.verdict === "confirmed" &&
      silentRecord.quietGapAfterWriteMs === SILENT_QUIET_GAP_MS &&
      silentRecord.pollRoundsBetween === 0,
    JSON.stringify(silentRecord)
  );
  const gsDuringSilence = roundsOf(engine.decodedRounds, "GS").filter(
    round =>
      silentAckedAt !== undefined &&
      round.decodedAt > silentAckedAt + 200 &&
      round.decodedAt < silentAckedAt + SILENT_QUIET_GAP_MS - 200
  );
  check("B: no GS round during that quiet gap", gsDuringSilence.length === 0, `${gsDuringSilence.length} rounds`);

  // The live knob, as a ws config patch would move it
  setQuietGapMs(0);
  await sleep(1_500);
  const interleavedWrite = await writeAndAwaitAck(engine.session, "GPMP000350");
  const interleavedAckedAt = interleavedWrite.ackedAt;
  const starvedRecord = await waitForTimingRecord(interleavedWrite, "GPMP000350", 12_000);
  const gaveUpAt = Date.now();
  await sleep(2_500);
  const counters = engine.session.exchangeCounters();
  const gsAfterGiveUp = roundsOf(engine.decodedRounds, "GS").filter(round => round.decodedAt > gaveUpAt);
  const gsDuringPhase = roundsOf(engine.decodedRounds, "GS")
    .map(round => round.decodedAt)
    .filter(decodedAt => interleavedAckedAt !== undefined && decodedAt >= interleavedAckedAt && decodedAt <= gaveUpAt);
  engine.dispose();
  const fakeEvents = await fake.stop();
  const summary = fakeEvents.find(event => event.event === "summary");

  check(
    "B: after the live switch to 0, the starved write is given up as never_applied at the deadline",
    starvedRecord?.verdict === "never_applied" &&
      starvedRecord.quietGapAfterWriteMs === 0 &&
      starvedRecord.ackToVerdictMs >= 5_900 &&
      starvedRecord.ackToVerdictMs <= 8_500 &&
      starvedRecord.readbacksStillOld >= 3,
    JSON.stringify(starvedRecord)
  );
  const neverAppliedErrorLogs = errorLogsCaptured
    .slice(errorLogsBefore)
    .filter(text => text.includes("never applied") && text.includes("GPMP000350"));
  check(
    "B: the give-up errorLogged (the P2 path) exactly once, and nothing else was errorLogged",
    neverAppliedErrorLogs.length === 1 && errorLogsCaptured.length - errorLogsBefore === 1,
    errorLogsCaptured.slice(errorLogsBefore).join(" | ")
  );
  check(
    "B: polling continued through the starved write's confirm phase and after the give-up",
    gsDuringPhase.length >= 4 && longestGap(gsDuringPhase) <= MAX_GS_GAP_WHILE_POLLING_MS && gsAfterGiveUp.length >= 1,
    `${gsDuringPhase.length} GS rounds in the phase (longest gap ${longestGap(gsDuringPhase)} ms), ${gsAfterGiveUp.length} after`
  );
  check(
    "B: the fake committed the first write only, the starved one is still pending",
    summary?.event === "summary" &&
      summary.pending_commits.join() === "GPMP000350" &&
      summary.commits_deferred_by_traffic >= 3 &&
      fakeEvents.filter(event => event.event === "committed").length === 1,
    JSON.stringify(summary)
  );
  check(
    "B: counted as one confirmed and one never-applied write",
    counters.writesConfirmed === 1 && counters.writesNeverApplied === 1,
    `confirmed ${counters.writesConfirmed}, never applied ${counters.writesNeverApplied}`
  );
}

function startEngine(device: string, quietGapAfterWriteMs: Accessor<number>) {
  const decodedRounds: DecodedRound[] = [];
  let session: ReturnType<typeof createInverterSession> | undefined;
  const dispose = createRoot(disposeRoot => {
    session = createInverterSession({
      devicePath: device,
      // Only the boot round reads the settings: every later GPMP readback is a confirm
      poll_values_interval_seconds: () => 600,
      quiet_gap_after_write_ms: quietGapAfterWriteMs,
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
  command: "GPMP000550" | "GPMP000350"
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

async function startFakeInverter(
  fakeArguments: readonly string[]
): Promise<{ device: string; stop: () => Promise<readonly FakeInverterEvent[]> }> {
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
