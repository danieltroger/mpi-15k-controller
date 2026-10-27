/**
 * Pure self-test of the PR #62 review scenarios, replayed through the simulated pump of
 * schedulerSimulation.ts (the reviewer's harness, typed), polling continuing through every write:
 *  1. a starved write pending with its gated identical copy queued — the write gives up on its own
 *     55 s deadline, before the copy's gate opens, so the copy never supersedes a pending check; a
 *     write to another setter meanwhile goes out at once and is confirmed
 *  2. 350 → 550 → 350 — the second 350 is never judged before its own 9 s, so the pre-550 readback
 *     can't "confirm" it
 *  3. a 3-write burst — a check confirmed on the first run leaves the phase, so its desired-state copy
 *     is dropped instead of re-sent at the gate
 * Each prints its timeline. Run from backend/ with:
 *   yarn node src/inverterComms/confirmPhaseScenarios.selftest.ts
 */
import process from "process";
import type { DecodedFields, SettingsQueryCommandName } from "./pi17Protocol.types.ts";
import {
  CONFIRM_GIVE_UP_AFTER_WRITE_MS,
  FIRST_CONFIRM_AFTER_WRITE_MS,
  IDENTICAL_SETTER_MIN_INTERVAL_MS,
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
  type ScenarioEvent,
  type SimulatedStep,
} from "./schedulerSimulation.ts";

const fails: string[] = [];
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name} ${detail}`);
  if (!cond) fails.push(name);
}

const seconds = (value: number) => value * 1000;
const FEED_GRID_FLAGS_DISABLED = {
  battery_discharge_to_feed_grid_when_solar_input_normal: "disabled",
  battery_discharge_to_feed_grid_when_solar_input_loss: "disabled",
};

// ---------- 1. a starved write pending, its gated copy queued, another setter's write meanwhile ----------
{
  const steps = runScenario({
    boot: { GPMP: { maximum_feeding_grid_power: 350 }, HECS: FEED_GRID_FLAGS_DISABLED },
    events: [
      queueSetterAt(seconds(100), "GPMP000550", "GPMP0"),
      queueSetterAt(seconds(101), "GPMP000550", "GPMP0"), // the consumer's desired-state copy, gated
      queueSetterAt(seconds(150.5), "EDF1", "EDF"),
    ],
    untilMs: seconds(260),
    commitDelayMs: 6_000,
    neverCommits: ["GPMP000550"],
  });
  const [firstGpmp, gatedCopy] = sendsIn(steps, "GPMP000550");
  const edf1 = sendsIn(steps, "EDF1")[0];
  const firstGiveUp = firstRunWith(steps, "gaveUpChecks", "GPMP000550");
  check(
    "1: EDF1, queued while GPMP000550's confirm runs, goes out at once (at most one round late)",
    edf1 !== undefined && edf1.startedAtMs - seconds(150.5) <= POLL_ROUND_DURATION_MS,
    `sent at ${secondsText(edf1?.startedAtMs)}`
  );
  const firstDeadline = (firstGpmp?.endedAtMs ?? 0) + CONFIRM_GIVE_UP_AFTER_WRITE_MS;
  check(
    "1: the starved GPMP000550 gives up on its own 55 s deadline, before its copy's gate",
    firstGiveUp !== undefined &&
      firstGiveUp.endedAtMs >= firstDeadline &&
      firstGiveUp.endedAtMs < (firstGpmp?.endedAtMs ?? 0) + IDENTICAL_SETTER_MIN_INTERVAL_MS,
    `give-up at ${secondsText(firstGiveUp?.endedAtMs)}, deadline ${secondsText(firstDeadline)}`
  );
  check(
    "1: …so the gated copy goes out only after that verdict, never superseding a pending check",
    gatedCopy !== undefined && firstGiveUp !== undefined && gatedCopy.startedAtMs > firstGiveUp.endedAtMs,
    `copy at ${secondsText(gatedCopy?.startedAtMs)}`
  );
  const edf1Confirmed = firstRunWith(steps, "confirmedChecks", "EDF1");
  check(
    "1: EDF1 is confirmed, and not judged before its own write + 9 s",
    edf1Confirmed !== undefined &&
      edf1 !== undefined &&
      edf1Confirmed.endedAtMs >= edf1.endedAtMs + FIRST_CONFIRM_AFTER_WRITE_MS
  );
}

// ---------- 2. 350 → 550 → 350: the second 350 gets its own 9 s window ----------
{
  const steps = runScenario({
    boot: { GPMP: { maximum_feeding_grid_power: 350 } },
    events: [queueSetterAt(seconds(100), "GPMP000550", "GPMP0"), queueSetterAt(seconds(103), "GPMP000350", "GPMP0")],
    untilMs: seconds(160),
    // Each commit lands 8 s after its own write: 550 at ~108.1 s, 350 at ~111.6 s
    commitDelayMs: 8_000,
  });
  const backTo350 = sendsIn(steps, "GPMP000350")[0];
  const back350CommitsAt = (backTo350?.endedAtMs ?? 0) + 8_000;
  const confirmedRun = firstRunWith(steps, "confirmedChecks", "GPMP000350");
  check(
    "2: GPMP000350 is confirmed only by a readback after its own commit",
    confirmedRun !== undefined && confirmedRun.endedAtMs >= back350CommitsAt,
    `confirmed at ${secondsText(confirmedRun?.endedAtMs)}, its commit at ${secondsText(back350CommitsAt)}`
  );
  const firstRun = confirmRunsIn(steps)[0];
  check(
    "2: the run on the 550's cadence (~109 s) leaves the ~6 s-old 350 unjudged",
    firstRun !== undefined &&
      firstRun.endedAtMs < (backTo350?.endedAtMs ?? 0) + FIRST_CONFIRM_AFTER_WRITE_MS &&
      namesOf(firstRun.result.notYetJudgedChecks) === "GPMP000350" &&
      firstRun.result.confirmedChecks.length === 0,
    `first run at ${secondsText(firstRun?.endedAtMs)}`
  );
  check(
    "2: every write lands, so nothing gives up",
    confirmRunsIn(steps).every(run => run.result.gaveUpChecks.length === 0)
  );
}

// ---------- 3. a 3-write burst: the confirmed copy is dropped ----------
{
  const steps = runScenario({
    boot: {
      GPMP: { maximum_feeding_grid_power: 350 },
      BATS: { "max._ac_charging_current": 6 },
      HECS: FEED_GRID_FLAGS_DISABLED,
    },
    events: [
      queueSetterAt(seconds(100), "GPMP000550", "GPMP0"),
      queueSetterAt(seconds(105), "GPMP000550", "GPMP0"), // desired-state re-queue, gated to ~160 s
      queueSetterAt(seconds(111), "MUCHGC0100", "MUCHGC"),
      queueSetterAt(seconds(122), "EDF1", "EDF"),
    ],
    untilMs: seconds(240),
    commitDelayMs: 6_000,
    neverCommits: ["MUCHGC0100"],
  });
  const gpmpConfirmed = firstRunWith(steps, "confirmedChecks", "GPMP000550");
  const muchgcGaveUp = firstRunWith(steps, "gaveUpChecks", "MUCHGC0100");
  const dropped = steps.find(step => step.action === "drop_setter" && step.command === "GPMP000550");
  check(
    "3: GPMP000550 is sent once — its copy is dropped right after the confirm, not re-sent at the gate",
    sendsIn(steps, "GPMP000550").length === 1 &&
      dropped !== undefined &&
      gpmpConfirmed !== undefined &&
      dropped.startedAtMs === gpmpConfirmed.endedAtMs,
    `confirmed and dropped at ${secondsText(gpmpConfirmed?.endedAtMs)}`
  );
  const muchgcSent = sendsIn(steps, "MUCHGC0100")[0];
  check(
    "3: MUCHGC0100 gives up on its own 55 s deadline, merged into the burst's phase or not",
    muchgcGaveUp !== undefined &&
      muchgcSent !== undefined &&
      muchgcGaveUp.endedAtMs >= muchgcSent.endedAtMs + CONFIRM_GIVE_UP_AFTER_WRITE_MS &&
      muchgcGaveUp.endedAtMs < muchgcSent.endedAtMs + IDENTICAL_SETTER_MIN_INTERVAL_MS,
    `give-up at ${secondsText(muchgcGaveUp?.endedAtMs)}`
  );
  check("3: EDF1 is confirmed", firstRunWith(steps, "confirmedChecks", "EDF1") !== undefined);
}

console.log(
  `\n${fails.length ? `${fails.length} FAILED: ${fails.join(", ")}` : "all confirmPhaseScenarios selftests passed"}`
);
process.exit(fails.length ? 1 : 0);

/** Boot, run the events until `untilMs`, print the timeline */
function runScenario({
  boot,
  events,
  untilMs,
  commitDelayMs,
  neverCommits = [],
}: {
  boot: Partial<Record<SettingsQueryCommandName, DecodedFields>>;
  events: readonly ScenarioEvent[];
  untilMs: number;
  commitDelayMs: number;
  neverCommits?: readonly string[];
}): SimulatedStep[] {
  const registers = registersFor(boot);
  const { steps } = simulatePump({
    initial: bootedScheduler({}, boot),
    registers,
    events,
    fromMs: seconds(100),
    untilMs,
    onSetterSent: commitsLandAfter(registers, commitDelayMs, neverCommits),
  });
  console.log(`  timeline:\n${describeTimeline(steps)}`);
  return steps;
}

function describeTimeline(steps: readonly SimulatedStep[]): string {
  return steps
    .flatMap(step => {
      const at = secondsText(step.endedAtMs);
      if (step.action === "send_setter") return [`    ${at} send ${step.command}`];
      if (step.action === "drop_setter") return [`    ${at} drop ${step.command}`];
      if (step.action === "poll_round") return [];
      const { confirmedChecks, gaveUpChecks, notYetJudgedChecks, retry } = step.result;
      const verdicts = [
        confirmedChecks.length ? `confirmed ${namesOf(confirmedChecks)}` : "",
        gaveUpChecks.length ? `GAVE UP ${namesOf(gaveUpChecks)}` : "",
        notYetJudgedChecks.length ? `not yet judged ${namesOf(notYetJudgedChecks)}` : "",
        retry ? `next ${secondsText(retry.retryAt)}` : "phase over",
      ];
      return [`    ${at} confirm ${step.queries.join("+")}: ${verdicts.filter(Boolean).join("; ")}`];
    })
    .join("\n");
}

function namesOf(checks: readonly PendingReadbackCheck[]): string {
  return [...new Set(checks.map(pendingCheck => pendingCheck.forCommand))].join(",");
}

function secondsText(milliseconds: number | undefined): string {
  return milliseconds === undefined ? "never" : `${(milliseconds / 1000).toFixed(2)} s`;
}
