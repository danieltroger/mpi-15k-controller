/**
 * Pure self-test of the confirm cadence when writes don't land, replayed through schedulerSimulation.ts
 * (grown from PR #62's delta review):
 *  1. a starved chain (nothing commits) of writes to different setters 40 s apart: each merges into the
 *     running phase, keeps its own 55 s give-up (a "never applied" each), nothing is held back, polling
 *     never pauses, and the phase ends once the last write has its verdict.
 *  2. the minimum-age rule (9 s) on a degraded line: a readback decoded early in a run that a timing-out
 *     query drags out must not judge a check that was younger than 9 s when the run started.
 *  3. #75's review: one field retargeted every 6–14 s (the buy current under continuous polling) that
 *     never commits — every check is superseded before its give-up, yet the field pages within ~60–70 s,
 *     once. The same churn committing normally never pages; a write that keeps its check pages through
 *     its give-up only (not again from the starved readbacks after it); a NAKed send never pages.
 * Run from backend/ with:
 *   yarn node src/inverterComms/starvedWrites.selftest.ts
 */
import process from "process";
import { afterConfirmRun, afterSetterSent, initialSchedulerState, withSettingsReadback } from "./schedulerCore.ts";
import {
  CONFIRM_GIVE_UP_AFTER_WRITE_MS,
  IDENTICAL_SETTER_MIN_INTERVAL_MS,
  STARVED_WRITE_PAGE_AFTER_MS,
} from "./schedulerTiming.ts";
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
  type ScenarioEvent,
  type SimulatedStep,
} from "./schedulerSimulation.ts";
import type { SchedulerState } from "./schedulerCore.ts";

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

// ---------- 3. a retargeted field: superseded checks never give up, the field pages anyway ----------
const LIMIT_FIELD = "max._ac_charging_current";
const RETARGETS = retargetEvery6To14Seconds(seconds(100), seconds(400));
{
  const { state, steps } = runBuyCurrentChurn(RETARGETS, undefined);
  const firstWriteAt = sendsIn(steps)[0]!.endedAtMs;
  const reports = state.starvedWriteReports;
  const pagedGiveUps = confirmRunsIn(steps).flatMap(run => run.pagedGiveUps);
  check(
    "never committing, retargeted every 6–14 s: the field pages 60–70 s after its first write",
    reports.length >= 1 &&
      reports[0]!.field === LIMIT_FIELD &&
      reports[0]!.write.sentAtMs === firstWriteAt &&
      reports[0]!.decodedAtMs - firstWriteAt >= STARVED_WRITE_PAGE_AFTER_MS &&
      reports[0]!.decodedAtMs - firstWriteAt <= STARVED_WRITE_PAGE_AFTER_MS + seconds(10),
    reports[0]
      ? `${secondsText(reports[0].decodedAtMs - firstWriteAt)} after it, ${reports[0].laterWrites} later writes`
      : "never paged"
  );
  check(
    "…once for the whole churn (5 min, " + sendsIn(steps).length + " writes): its give-ups add no second page",
    reports.length === 1 && pagedGiveUps.length === 0,
    `${reports.length} starved report(s), ${pagedGiveUps.length} paged give-up(s), ${confirmRunsIn(steps).flatMap(run => run.result.gaveUpChecks).length} give-up(s) in all`
  );
}
{
  // The target bouncing off what the field already holds (the buy current at its cap): every other write is
  // the boot 290 A the readbacks show, which mustn't count as the field having moved on
  const bouncing = RETARGETS.map((retarget, index) => ({ ...retarget, amps: index % 2 ? 290 : retarget.amps }));
  const { state, steps } = runBuyCurrentChurn(bouncing, undefined);
  const firstWriteAt = sendsIn(steps)[0]!.endedAtMs;
  const firstReport = state.starvedWriteReports[0];
  check(
    "never committing, bouncing between the held 290 A and lower targets: pages 60–70 s after the first write",
    firstReport !== undefined &&
      firstReport.decodedAtMs - firstWriteAt >= STARVED_WRITE_PAGE_AFTER_MS &&
      firstReport.decodedAtMs - firstWriteAt <= STARVED_WRITE_PAGE_AFTER_MS + seconds(10) &&
      state.starvedWriteReports.length === 1,
    firstReport
      ? `${secondsText(firstReport.decodedAtMs - firstWriteAt)} after it, ${state.starvedWriteReports.length} report(s)`
      : "never paged"
  );
}
for (const commitDelayMs of [9_000, 11_500, 20_000]) {
  const { state, steps } = runBuyCurrentChurn(RETARGETS, commitDelayMs);
  const giveUps = confirmRunsIn(steps).flatMap(run => run.result.gaveUpChecks);
  check(
    `committing ${commitDelayMs / 1000} s after each write, retargeted every 6–14 s: never pages`,
    state.starvedWriteReports.length === 0 && giveUps.length === 0,
    `${state.starvedWriteReports.length} starved report(s), ${giveUps.length} give-up(s), ${sendsIn(steps).length} writes`
  );
}
{
  // A stuck MUCHGC that keeps its check, BATS read on for a while by MCHGV's confirms: one page, the give-up's
  const registers = registersFor({
    BATS: {
      [LIMIT_FIELD]: 290,
      "battery_constant_charge_voltage(c.v.)": 56,
      battery_floating_charge_voltage: 56,
    },
  });
  // Distinct voltages: an identical MCHGV within 60 s would wait for its gate
  const voltageWrites = [570, 565, 560, 555, 550, 545, 540, 535].map((deciVolts, index) =>
    queueSetterAt(seconds(110 + 20 * index), `MCHGV0${deciVolts},0${deciVolts}`, "MCHGV")
  );
  const { state, steps } = simulatePump({
    initial: bootedScheduler({}, { BATS: { [LIMIT_FIELD]: 290 } }),
    registers,
    events: [queueSetterAt(seconds(100), "MUCHGC2550", "MUCHGC"), ...voltageWrites],
    fromMs: seconds(100),
    untilMs: seconds(300),
    onSetterSent: commitsLandAfter(registers, 9_000, ["MUCHGC2550"]),
  });
  const pagedGiveUps = confirmRunsIn(steps).flatMap(run => run.pagedGiveUps);
  const batsReadsLater = confirmRunsIn(steps).filter(
    run => run.queries.includes("BATS") && run.endedAtMs > seconds(100) + STARVED_WRITE_PAGE_AFTER_MS
  ).length;
  check(
    "a stuck write that keeps its check pages through its give-up only — the starved readbacks after it don't page again",
    pagedGiveUps.length === 1 &&
      pagedGiveUps[0]!.forCommand === "MUCHGC2550" &&
      state.starvedWriteReports.length === 0 &&
      batsReadsLater >= 3,
    `${pagedGiveUps.length} paged give-up(s), ${state.starvedWriteReports.length} starved report(s), ${batsReadsLater} BATS reads after 60 s`
  );
}
{
  // A NAKed (or unanswered) send is chained — it may still have committed — but never pages as starved
  let state = withSettingsReadback(initialSchedulerState(), "BATS", { [LIMIT_FIELD]: 290 }, seconds(0));
  state = afterSetterSent(state, "MUCHGC2550", ["BATS"], seconds(1), false);
  state = withSettingsReadback(state, "BATS", { [LIMIT_FIELD]: 290 }, seconds(1) + STARVED_WRITE_PAGE_AFTER_MS + 5_000);
  check("a NAKed send still unseen after 65 s doesn't page", state.starvedWriteReports.length === 0);
  state = afterSetterSent(state, "MUCHGC2560", ["BATS"], seconds(70), true);
  state = withSettingsReadback(state, "BATS", { [LIMIT_FIELD]: 290 }, seconds(70) + STARVED_WRITE_PAGE_AFTER_MS);
  check(
    "…but an ACKed one behind it does, naming the ACKed write",
    state.starvedWriteReports.length === 1 && state.starvedWriteReports[0]!.write.value === 256
  );
  state = withSettingsReadback(
    state,
    "BATS",
    { [LIMIT_FIELD]: 256 },
    seconds(70) + STARVED_WRITE_PAGE_AFTER_MS + 4_000
  );
  state = afterSetterSent(state, "MUCHGC2570", ["BATS"], seconds(140), true);
  state = withSettingsReadback(state, "BATS", { [LIMIT_FIELD]: 256 }, seconds(140) + STARVED_WRITE_PAGE_AFTER_MS);
  check(
    "once the field has moved (256 showed), a later starved write opens a new episode and pages again",
    state.starvedWriteReports.length === 2 && state.starvedWriteReports[1]!.write.value === 257
  );
}

console.log(`\n${fails.length ? `${fails.length} FAILED: ${fails.join(", ")}` : "all starvedWrites selftests passed"}`);
process.exit(fails.length ? 1 : 0);

/** The buy current's 1 A target moving every 6–14 s (a fixed pseudo-random walk between 250 and 258 A) */
function retargetEvery6To14Seconds(fromMs: number, untilMs: number): { atMs: number; amps: number }[] {
  const retargets: { atMs: number; amps: number }[] = [];
  let randomState = 52_075;
  let amps = 254;
  for (let atMs = fromMs; atMs < untilMs; ) {
    randomState = (randomState * 1_103_515_245 + 12_345) % 2 ** 31;
    const roll = randomState / 2 ** 31;
    amps = Math.min(
      258,
      Math.max(250, amps + (roll < 0.5 ? -1 - Math.floor(roll * 6) : 1 + Math.floor((roll - 0.5) * 6)))
    );
    retargets.push({ atMs, amps });
    atMs += 6_000 + Math.floor(roll * 8_000);
  }
  return retargets;
}

/** The retargets as MUCHGC writes against a BATS register booted at 290 A: committing after `commitDelayMs`, or never */
function runBuyCurrentChurn(
  retargets: readonly { atMs: number; amps: number }[],
  commitDelayMs: number | undefined
): { state: SchedulerState; steps: SimulatedStep[] } {
  const boot = { BATS: { [LIMIT_FIELD]: 290 } };
  const registers = registersFor(boot);
  const commands = retargets.map(retarget => `MUCHGC${String(retarget.amps * 10).padStart(4, "0")}`);
  const events: ScenarioEvent[] = retargets.map((retarget, index) =>
    queueSetterAt(retarget.atMs, commands[index]!, "MUCHGC")
  );
  return simulatePump({
    initial: bootedScheduler({}, boot),
    registers,
    events,
    fromMs: retargets[0]!.atMs,
    untilMs: retargets.at(-1)!.atMs + seconds(120),
    onSetterSent: commitsLandAfter(registers, commitDelayMs ?? 0, commitDelayMs === undefined ? commands : []),
  });
}

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
