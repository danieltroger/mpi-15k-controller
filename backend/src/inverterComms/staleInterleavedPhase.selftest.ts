/**
 * Pure self-test of the PR #62 delta-review scenarios, replayed through schedulerSimulation.ts:
 *  1–2. under starvation (nothing commits), writes to different setters 40 s apart used to keep a
 *       gap-0 phase alive past the starvation fallback and an operator revert, every new write
 *       merging in at gap 0 with polling running. A gap-0 phase that new phases no longer match is
 *       now stale: it finishes, setters wait for it (≤ 55 s), and every later write is silent.
 *  3.   a revert before any give-up: the next write waits for the running phase, then goes silent.
 *  4.   the 6 s rule on a degraded line: a readback decoded early in a run that a timing-out query
 *       drags out must not judge a check that was younger than 6 s when the run started.
 * Run from backend/ with:
 *   yarn node src/inverterComms/staleInterleavedPhase.selftest.ts
 */
import process from "process";
import { afterConfirmRun, afterSetterSent, initialSchedulerState } from "./schedulerCore.ts";
import { INTERLEAVED_CONFIRM_GIVE_UP_AFTER_WRITE_MS } from "./schedulerTiming.ts";
import type { PendingReadbackCheck } from "./schedulerCore.ts";
import {
  bootedScheduler,
  commitsLandAfter,
  firstRunWith,
  knobChangeAt,
  POLL_ROUND_DURATION_MS,
  queueSetterAt,
  registersFor,
  sendsIn,
  simulatePump,
  type ScenarioEvent,
  type SimulatedSend,
  type SimulatedStep,
} from "./schedulerSimulation.ts";

const fails: string[] = [];
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name} ${detail}`);
  if (!cond) fails.push(name);
}

const seconds = (value: number) => value * 1000;
const BOOT_READBACKS = {
  GPMP: { maximum_feeding_grid_power: 350 },
  HECS: {
    battery_discharge_to_feed_grid_when_solar_input_normal: "disabled",
    battery_discharge_to_feed_grid_when_solar_input_loss: "disabled",
  },
  BATS: { "max._ac_charging_current": 6 },
};
const EVERY_WRITE = ["GPMP000550", "EDF1", "EDG1", "GPMP000600", "MUCHGC0100"];
/** The review's chain: writes to different setters 40 s apart, every one of them starved */
const CHAIN_OF_WRITES = [
  queueSetterAt(seconds(100), "GPMP000550", "GPMP0"),
  queueSetterAt(seconds(140), "EDF1", "EDF"),
  queueSetterAt(seconds(180), "EDG1", "EDG"),
  queueSetterAt(seconds(220), "GPMP000600", "GPMP0"),
  queueSetterAt(seconds(260), "MUCHGC0100", "MUCHGC"),
];

// ---------- 1–2. a starved chain: the fallback (and a revert at 200 s) reach every later write ----------
// The revert at 170 s lands while the fallback-stale phase still runs: the hold carries across the
// hand-over of the stale reason from the fallback to the knob
for (const revertAtMs of [seconds(170), undefined]) {
  const label = revertAtMs === undefined ? "knob left at 0" : "operator reverts at 170 s";
  const events = revertAtMs === undefined ? CHAIN_OF_WRITES : [...CHAIN_OF_WRITES, knobChangeAt(revertAtMs, 12_000)];
  const steps = runScenario(label, events, seconds(400), EVERY_WRITE);
  const latched = firstRunWith(steps, "gaveUpChecks", "GPMP000550");
  check(
    `chain (${label}): the first give-up latches the fallback`,
    latched?.result.starvationFallback !== undefined,
    `at ${secondsText(latched?.endedAtMs)}`
  );
  const edf1 = sendsIn(steps, "EDF1")[0];
  const staleEnded = firstRunWith(steps, "gaveUpChecks", "EDF1");
  check(
    `chain (${label}): EDF1, merged before the latch, still gets its own 55 s verdict`,
    edf1?.armed?.strategy === "interleaved" &&
      staleEnded !== undefined &&
      staleEnded.endedAtMs >= edf1.endedAtMs + INTERLEAVED_CONFIRM_GIVE_UP_AFTER_WRITE_MS &&
      staleEnded.result.retry === undefined,
    `phase over at ${secondsText(staleEnded?.endedAtMs)}`
  );
  const edg1 = sendsIn(steps, "EDG1")[0];
  check(
    `chain (${label}): EDG1, queued at 180 s, waits for that stale phase (≤ 55 s after its newest write)`,
    edg1 !== undefined &&
      staleEnded !== undefined &&
      edf1 !== undefined &&
      edg1.startedAtMs >= staleEnded.endedAtMs &&
      edg1.startedAtMs <= edf1.endedAtMs + INTERLEAVED_CONFIRM_GIVE_UP_AFTER_WRITE_MS + 2 * POLL_ROUND_DURATION_MS,
    `sent at ${secondsText(edg1?.startedAtMs)}`
  );
  const sendsAfterLatch = sendsIn(steps).filter(send => latched !== undefined && send.startedAtMs > latched.endedAtMs);
  check(
    `chain (${label}): every write after the latch runs on the silent 12 s gap`,
    sendsAfterLatch.length === 3 &&
      sendsAfterLatch.every(send => send.armed?.strategy === "silent" && send.armed.quietGapAfterWriteMs === 12_000),
    describeSends(sendsAfterLatch)
  );
  check(
    `chain (${label}): no poll round runs while the later writes' silent phases are open`,
    !pollRoundsDuringSilentPhases(steps),
    `${steps.filter(step => step.action === "poll_round").length} poll rounds in all`
  );
}

// ---------- 3. a revert while a gap-0 write is pending, before any give-up ----------
{
  const steps = runScenario(
    "revert at 120 s, EDF1 queued at 130 s",
    [
      queueSetterAt(seconds(100), "GPMP000550", "GPMP0"),
      knobChangeAt(seconds(120), 12_000),
      queueSetterAt(seconds(130), "EDF1", "EDF"),
    ],
    seconds(200),
    ["GPMP000550"]
  );
  const gpmpGaveUp = firstRunWith(steps, "gaveUpChecks", "GPMP000550");
  const edf1 = sendsIn(steps, "EDF1")[0];
  check(
    "revert: EDF1 is held until the stale phase's give-up, then armed silent 12 s",
    gpmpGaveUp !== undefined &&
      edf1 !== undefined &&
      edf1.startedAtMs >= gpmpGaveUp.endedAtMs &&
      edf1.armed?.strategy === "silent" &&
      edf1.armed.quietGapAfterWriteMs === 12_000,
    `give-up ${secondsText(gpmpGaveUp?.endedAtMs)}, EDF1 sent ${secondsText(edf1?.startedAtMs)}`
  );
  check(
    "revert: the give-up after the operator's revert starts no fallback",
    gpmpGaveUp?.result.starvationFallback === undefined && gpmpGaveUp?.stateAfter.starvationFallback === false
  );
  check(
    "revert: EDF1 commits in its silence and is confirmed",
    firstRunWith(steps, "confirmedChecks", "EDF1") !== undefined
  );
}

// ---------- 4. the 6 s rule is judged at the run's start (degraded line) ----------
{
  let state = initialSchedulerState({ quietGapAfterWriteMs: 0 });
  state = afterSetterSent(state, "GPMP000550", ["GPMP"], seconds(100), true);
  state = afterSetterSent(state, "EDF1", ["HECS"], seconds(101), true);
  state = afterSetterSent(state, "GPMP000350", ["GPMP"], seconds(103.5), true);
  // The run due at 106 s decodes GPMP at 106.15 s (still the pre-550 350); HECS then times out
  // twice (2 × 3 s + 0.3 s quiet), so the run ends at ~112.45 s with no HECS fields
  const runStartedAtMs = seconds(106);
  const runEndedAtMs = runStartedAtMs + 150 + 6_300;
  const stale350Readback = { GPMP: { maximum_feeding_grid_power: 350 } };
  const judgedAtStart = afterConfirmRun(state, stale350Readback, runEndedAtMs, runStartedAtMs).result;
  check(
    "degraded line: GPMP000350 (2.5 s old at the run's start) is not judged on that readback",
    judgedAtStart.confirmedChecks.length === 0 &&
      namesOf(judgedAtStart.notYetJudgedChecks) === "EDF1,GPMP000350" &&
      judgedAtStart.retry !== undefined &&
      judgedAtStart.retry.retryAt <= runEndedAtMs,
    `not yet judged ${namesOf(judgedAtStart.notYetJudgedChecks)}, next run ${secondsText(judgedAtStart.retry?.retryAt)}`
  );
  const judgedAtEnd = afterConfirmRun(state, stale350Readback, runEndedAtMs).result;
  check(
    "degraded line: judged by the run's end the 6 s rule alone would let it through — the write chain still refuses the 550-pending 350",
    !judgedAtEnd.notYetJudgedChecks.some(youngCheck => youngCheck.forCommand === "GPMP000350") &&
      judgedAtEnd.confirmedChecks.length === 0,
    `confirmed ${namesOf(judgedAtEnd.confirmedChecks) || "nothing"}`
  );
}

console.log(
  `\n${fails.length ? `${fails.length} FAILED: ${fails.join(", ")}` : "all staleInterleavedPhase selftests passed"}`
);
process.exit(fails.length ? 1 : 0);

function runScenario(
  label: string,
  events: readonly ScenarioEvent[],
  untilMs: number,
  neverCommits: readonly string[]
): SimulatedStep[] {
  const registers = registersFor(BOOT_READBACKS);
  const { steps } = simulatePump({
    initial: bootedScheduler({ quietGapAfterWriteMs: 0 }, BOOT_READBACKS),
    registers,
    events,
    fromMs: seconds(100),
    untilMs,
    onSetterSent: commitsLandAfter(registers, 6_000, neverCommits),
  });
  console.log(`  timeline (${label}):\n${describeTimeline(steps)}`);
  return steps;
}

/** Is there a poll round between a silent write and the end of the confirm run that closes its phase? */
function pollRoundsDuringSilentPhases(steps: readonly SimulatedStep[]): boolean {
  let silentPhaseOpen = false;
  for (const step of steps) {
    if (step.action === "send_setter") silentPhaseOpen = step.armed?.strategy === "silent";
    if (step.action === "run_confirms" && !step.result.retry) silentPhaseOpen = false;
    if (step.action === "poll_round" && silentPhaseOpen) return true;
  }
  return false;
}

function describeTimeline(steps: readonly SimulatedStep[]): string {
  return steps
    .flatMap(step => {
      const at = secondsText(step.endedAtMs);
      if (step.action === "send_setter") {
        return [`    ${at} send ${step.command} → ${step.armed?.strategy} ${step.armed?.quietGapAfterWriteMs} ms`];
      }
      if (step.action !== "run_confirms") return [];
      const { confirmedChecks, gaveUpChecks, retry, starvationFallback } = step.result;
      const verdicts = [
        confirmedChecks.length ? `confirmed ${namesOf(confirmedChecks)}` : "",
        gaveUpChecks.length ? `GAVE UP ${namesOf(gaveUpChecks)}` : "",
        retry ? "" : "phase over",
        starvationFallback ? "FALLBACK" : "",
      ].filter(Boolean);
      return verdicts.length ? [`    ${at} confirm ${step.queries.join("+")}: ${verdicts.join("; ")}`] : [];
    })
    .join("\n");
}

function describeSends(sends: readonly SimulatedSend[]): string {
  return sends.map(send => `${send.command}@${secondsText(send.startedAtMs)} ${send.armed?.strategy}`).join(", ");
}

function namesOf(checks: readonly PendingReadbackCheck[]): string {
  return [...new Set(checks.map(pendingCheck => pendingCheck.forCommand))].sort().join(",");
}

function secondsText(milliseconds: number | undefined): string {
  return milliseconds === undefined ? "never" : `${(milliseconds / 1000).toFixed(2)} s`;
}
