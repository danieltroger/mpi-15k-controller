/**
 * Pure self-test of the confirm cadence when writes don't land, replayed through schedulerSimulation.ts
 * (grown from PR #62's delta review):
 *  1. a starved chain (nothing commits) of writes to different setters 40 s apart: each merges into the
 *     running phase, keeps its own 55 s give-up (a "never applied" each), nothing is held back, polling
 *     never pauses, and the phase ends once the last write has its verdict.
 *  2. the minimum-age rule (9 s) on a degraded line: a readback decoded early in a run that a timing-out
 *     query drags out must not judge a check that was younger than 9 s when the run started.
 * Run from backend/ with:
 *   yarn node src/inverterComms/starvedWrites.selftest.ts
 */
import process from "process";
import { afterConfirmRun, afterSetterSent, initialSchedulerState } from "./schedulerCore.ts";
import { CONFIRM_GIVE_UP_AFTER_WRITE_MS, IDENTICAL_SETTER_MIN_INTERVAL_MS } from "./schedulerTiming.ts";
import type { PendingReadbackCheck } from "./schedulerCore.ts";
import {
  bootedScheduler,
  commitsLandAfter,
  confirmRunsIn,
  firstRunWith,
  POLL_ROUND_DURATION_MS,
  queueSetterAt,
  registersFor,
  sendsIn,
  simulatePump,
  startTimesOf,
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

// ---------- 1. a starved chain: every write gets its own give-up, nothing waits, polling never stops ----------
{
  const registers = registersFor(BOOT_READBACKS);
  const { state, steps } = simulatePump({
    initial: bootedScheduler({}, BOOT_READBACKS),
    registers,
    events: CHAIN_OF_WRITES,
    fromMs: seconds(100),
    untilMs: seconds(400),
    onSetterSent: commitsLandAfter(registers, 6_000, EVERY_WRITE),
  });
  console.log(`  timeline:\n${describeTimeline(steps)}`);
  const sends = sendsIn(steps);
  check(
    "every write goes out when queued (at most one round late) — nothing is held behind the running phase",
    sends.length === CHAIN_OF_WRITES.length &&
      sends.every((send, index) => send.startedAtMs - CHAIN_OF_WRITES[index]!.atMs <= POLL_ROUND_DURATION_MS),
    sends.map(send => `${send.command}@${secondsText(send.startedAtMs)}`).join(", ")
  );
  const lateVerdicts = sends.filter(send => {
    const gaveUp = firstRunWith(steps, "gaveUpChecks", send.command);
    return (
      gaveUp === undefined ||
      gaveUp.endedAtMs < send.endedAtMs + CONFIRM_GIVE_UP_AFTER_WRITE_MS ||
      gaveUp.endedAtMs >= send.endedAtMs + IDENTICAL_SETTER_MIN_INTERVAL_MS
    );
  });
  check(
    "each write gives up at its own 55 s deadline (before its 60 s identical-setter gate), merged or not",
    lateVerdicts.length === 0,
    lateVerdicts.map(send => send.command).join(", ")
  );
  const pollStarts = startTimesOf(steps, "poll_round");
  const longestPollGap = Math.max(...pollStarts.slice(1).map((startedAt, index) => startedAt - pollStarts[index]!));
  check(
    "polling never pauses for the confirms (longest gap between poll rounds ≤ 2 rounds)",
    longestPollGap <= 2 * POLL_ROUND_DURATION_MS,
    `${longestPollGap} ms`
  );
  const lastGiveUp = confirmRunsIn(steps).at(-1);
  check(
    "the phase ends with the last write's give-up",
    state.confirm === undefined &&
      lastGiveUp !== undefined &&
      lastGiveUp.result.gaveUpChecks.some(gaveUpCheck => gaveUpCheck.forCommand === "MUCHGC0100") &&
      lastGiveUp.result.retry === undefined
  );
}

// ---------- 2. the minimum-age rule is judged at the run's start (degraded line) ----------
{
  let state = initialSchedulerState();
  state = afterSetterSent(state, "GPMP000550", ["GPMP"], seconds(100), true);
  state = afterSetterSent(state, "EDF1", ["HECS"], seconds(101), true);
  state = afterSetterSent(state, "GPMP000350", ["GPMP"], seconds(103.5), true);
  // A run starting at 109 s decodes GPMP at 109.15 s (still the pre-550 350); HECS then times out
  // twice (2 × 3 s + 0.3 s quiet), so the run ends at ~115.45 s with no HECS fields
  const runStartedAtMs = seconds(109);
  const runEndedAtMs = runStartedAtMs + 150 + 6_300;
  const stale350Readback = { GPMP: { maximum_feeding_grid_power: 350 } };
  const judgedAtStart = afterConfirmRun(state, stale350Readback, runEndedAtMs, runStartedAtMs).result;
  check(
    "degraded line: GPMP000350 (5.5 s old at the run's start) is not judged on that readback",
    judgedAtStart.confirmedChecks.length === 0 &&
      namesOf(judgedAtStart.notYetJudgedChecks) === "EDF1,GPMP000350" &&
      judgedAtStart.retry !== undefined &&
      judgedAtStart.retry.retryAt <= runEndedAtMs,
    `not yet judged ${namesOf(judgedAtStart.notYetJudgedChecks)}, next run ${secondsText(judgedAtStart.retry?.retryAt)}`
  );
  const judgedAtEnd = afterConfirmRun(state, stale350Readback, runEndedAtMs).result;
  check(
    "degraded line: judged by the run's end the 9 s rule alone would let it through — the write chain still refuses the 550-pending 350",
    !judgedAtEnd.notYetJudgedChecks.some(youngCheck => youngCheck.forCommand === "GPMP000350") &&
      judgedAtEnd.confirmedChecks.length === 0,
    `confirmed ${namesOf(judgedAtEnd.confirmedChecks) || "nothing"}`
  );
}

console.log(`\n${fails.length ? `${fails.length} FAILED: ${fails.join(", ")}` : "all starvedWrites selftests passed"}`);
process.exit(fails.length ? 1 : 0);

function describeTimeline(steps: readonly SimulatedStep[]): string {
  return steps
    .flatMap(step => {
      const at = secondsText(step.endedAtMs);
      if (step.action === "send_setter") return [`    ${at} send ${step.command}`];
      if (step.action !== "run_confirms") return [];
      const { confirmedChecks, gaveUpChecks, retry } = step.result;
      const verdicts = [
        confirmedChecks.length ? `confirmed ${namesOf(confirmedChecks)}` : "",
        gaveUpChecks.length ? `GAVE UP ${namesOf(gaveUpChecks)}` : "",
        retry ? "" : "phase over",
      ].filter(Boolean);
      return verdicts.length ? [`    ${at} confirm ${step.queries.join("+")}: ${verdicts.join("; ")}`] : [];
    })
    .join("\n");
}

function namesOf(checks: readonly PendingReadbackCheck[]): string {
  return [...new Set(checks.map(pendingCheck => pendingCheck.forCommand))].sort().join(",");
}

function secondsText(milliseconds: number | undefined): string {
  return milliseconds === undefined ? "never" : `${(milliseconds / 1000).toFixed(2)} s`;
}
