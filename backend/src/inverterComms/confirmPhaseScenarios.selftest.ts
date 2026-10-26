/**
 * Pure self-test of the PR #62 review scenarios, replayed through the simulated pump of
 * schedulerSimulation.ts (the reviewer's harness, typed):
 *  1. revert while a starved gap-0 write is pending — the running phase keeps its strategy, so the
 *     write still gives up on its own 55 s deadline, before its gated identical copy can supersede it;
 *     the next write waits for that verdict instead of joining the stale gap-0 phase
 *  2. 350 → 550 → 350 at gap 0 — the second 350 is never judged before its own 6 s, so the
 *     pre-550 readback can't "confirm" it; at the default a 350 read back with the 550 never seen is
 *     ambiguous (fieldWriteChains.ts) and resolves at the backoff re-check
 *  3. the default gap on a 3-write burst — a check confirmed on the first run leaves the phase, so
 *     its desired-state copy is dropped instead of re-sent at the gate (an improvement over main)
 *  4. the starvation fallback — one gap-0 give-up puts later writes back on the silent 12 s gap
 *     until the knob next changes
 * Each prints its timeline. Run from backend/ with:
 *   yarn node src/inverterComms/confirmPhaseScenarios.selftest.ts
 */
import process from "process";
import type { DecodedFields, SettingsQueryCommandName } from "./pi17Protocol.types.ts";
import { IDENTICAL_SETTER_MIN_INTERVAL_MS, INTERLEAVED_CONFIRM_GIVE_UP_AFTER_WRITE_MS } from "./schedulerTiming.ts";
import type { PendingReadbackCheck } from "./schedulerCore.ts";
import {
  bootedScheduler,
  commitsLandAfter,
  confirmRunsIn,
  firstRunWith,
  knobChangeAt,
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

// ---------- 1. revert (0 → 12000) while a starved gap-0 write is pending ----------
{
  const steps = runScenario({
    quietGapAfterWriteMs: 0,
    boot: { GPMP: { maximum_feeding_grid_power: 350 }, HECS: FEED_GRID_FLAGS_DISABLED },
    events: [
      queueSetterAt(seconds(100), "GPMP000550", "GPMP0"),
      queueSetterAt(seconds(101), "GPMP000550", "GPMP0"), // the consumer's desired-state copy, gated
      knobChangeAt(seconds(150), 12_000),
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
    "1: EDF1, queued after the revert, waits for the stale gap-0 phase's verdict, then arms the silent 12 s",
    edf1 !== undefined &&
      firstGiveUp !== undefined &&
      edf1.startedAtMs >= firstGiveUp.endedAtMs &&
      edf1.armed?.strategy === "silent" &&
      edf1.armed.quietGapAfterWriteMs === 12_000,
    JSON.stringify({
      sentAt: edf1?.startedAtMs,
      strategy: edf1?.armed?.strategy,
      gap: edf1?.armed?.quietGapAfterWriteMs,
    })
  );
  const firstDeadline = (firstGpmp?.endedAtMs ?? 0) + INTERLEAVED_CONFIRM_GIVE_UP_AFTER_WRITE_MS;
  check(
    "1: the starved GPMP000550 gives up on its own 55 s deadline (interleaved), before its copy's gate",
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
  check(
    "1: the operator had already reverted, so no starvation fallback starts",
    confirmRunsIn(steps).every(run => run.result.starvationFallback === undefined)
  );
  check(
    "1: the copy, the first write after the gap-0 phase, arms the reverted 12 s silent strategy",
    gatedCopy?.armed?.strategy === "silent" && gatedCopy.armed.quietGapAfterWriteMs === 12_000
  );
  const edf1Confirmed = firstRunWith(steps, "confirmedChecks", "EDF1");
  check(
    "1: EDF1 is confirmed, and not judged before its own write + 6 s",
    edf1Confirmed !== undefined && edf1 !== undefined && edf1Confirmed.endedAtMs >= edf1.endedAtMs + 6_000
  );
}

// ---------- 2. 350 → 550 → 350 at gap 0: the second 350 gets its own 6 s window ----------
for (const quietGapAfterWriteMs of [0, 12_000]) {
  const steps = runScenario({
    quietGapAfterWriteMs,
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
    `2 (gap ${quietGapAfterWriteMs}): GPMP000350 is confirmed only by a readback after its own commit`,
    confirmedRun !== undefined && confirmedRun.endedAtMs >= back350CommitsAt,
    `confirmed at ${secondsText(confirmedRun?.endedAtMs)}, its commit at ${secondsText(back350CommitsAt)}`
  );
  if (quietGapAfterWriteMs === 12_000) {
    const [firstConfirm, backoffConfirm] = confirmRunsIn(steps);
    check(
      '2 (gap 12000): the 350 at the first confirm can\'t tell "both landed" from "nothing yet" — re-checked after the backoff, not given up',
      firstConfirm?.result.retry !== undefined &&
        backoffConfirm === confirmedRun &&
        confirmRunsIn(steps).every(run => run.result.gaveUpChecks.length === 0),
      `first confirm ${secondsText(firstConfirm?.endedAtMs)}, confirmed ${secondsText(confirmedRun?.endedAtMs)}`
    );
  }
  if (quietGapAfterWriteMs === 0) {
    const firstRun = confirmRunsIn(steps)[0];
    check(
      "2 (gap 0): the run on the 550's cadence (~107 s) leaves the 3.5 s-old 350 unjudged",
      firstRun !== undefined &&
        firstRun.endedAtMs < (backTo350?.endedAtMs ?? 0) + 6_000 &&
        namesOf(firstRun.result.notYetJudgedChecks) === "GPMP000350" &&
        firstRun.result.confirmedChecks.length === 0,
      `first run at ${secondsText(firstRun?.endedAtMs)}`
    );
  }
}

// ---------- 3. the default gap on a 3-write burst: the confirmed copy is dropped (better than main) ----------
{
  const steps = runScenario({
    quietGapAfterWriteMs: 12_000,
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
  check(
    "3: MUCHGC0100 gives up after one silent backoff (~165 s; main re-arms at the gate and gives up at ~203 s)",
    muchgcGaveUp !== undefined && muchgcGaveUp.endedAtMs < seconds(170),
    `give-up at ${secondsText(muchgcGaveUp?.endedAtMs)}`
  );
  check("3: EDF1 is confirmed", firstRunWith(steps, "confirmedChecks", "EDF1") !== undefined);
}

// ---------- 4. the starvation fallback ----------
{
  const steps = runScenario({
    quietGapAfterWriteMs: 0,
    boot: { GPMP: { maximum_feeding_grid_power: 350 }, HECS: FEED_GRID_FLAGS_DISABLED },
    events: [
      queueSetterAt(seconds(100), "GPMP000550", "GPMP0"),
      queueSetterAt(seconds(170), "EDF1", "EDF"),
      queueSetterAt(seconds(200), "EDG1", "EDG"),
      knobChangeAt(seconds(240), 12_000),
      knobChangeAt(seconds(245), 0),
      queueSetterAt(seconds(250), "EDG0", "EDG"),
    ],
    untilMs: seconds(290),
    commitDelayMs: 6_000,
    neverCommits: ["GPMP000550"],
  });
  const giveUp = firstRunWith(steps, "gaveUpChecks", "GPMP000550");
  check(
    "4: the starved gap-0 write's give-up starts the fallback to the 12 s silent gap",
    giveUp?.result.starvationFallback?.quietGapAfterWriteMs === 12_000 && giveUp.stateAfter.starvationFallback,
    JSON.stringify(giveUp?.result.starvationFallback)
  );
  const [edf1, edg1] = [sendsIn(steps, "EDF1")[0], sendsIn(steps, "EDG1")[0]];
  check(
    "4: with the knob still at 0, the next writes arm silent 12 s phases",
    [edf1, edg1].every(send => send?.armed?.strategy === "silent" && send.armed.quietGapAfterWriteMs === 12_000),
    [edf1, edg1]
      .map(send => `${send?.command} ${send?.armed?.strategy}/${send?.armed?.quietGapAfterWriteMs}`)
      .join(", ")
  );
  check(
    "4: …and the fallback starts once, not per later run",
    confirmRunsIn(steps).filter(run => run.result.starvationFallback !== undefined).length === 1
  );
  const edg0 = sendsIn(steps, "EDG0")[0];
  check(
    "4: changing the knob (12000, then 0 again) ends the fallback — the next write is interleaved",
    edg0?.armed?.strategy === "interleaved" && edg0.armed.quietGapAfterWriteMs === 0
  );
  check(
    "4: the writes under the fallback commit in the silence and are confirmed",
    ["EDF1", "EDG1", "EDG0"].every(command => firstRunWith(steps, "confirmedChecks", command) !== undefined)
  );
}

console.log(
  `\n${fails.length ? `${fails.length} FAILED: ${fails.join(", ")}` : "all confirmPhaseScenarios selftests passed"}`
);
process.exit(fails.length ? 1 : 0);

/** Boot at the given gap, run the events until `untilMs`, print the timeline */
function runScenario({
  quietGapAfterWriteMs,
  boot,
  events,
  untilMs,
  commitDelayMs,
  neverCommits = [],
}: {
  quietGapAfterWriteMs: number;
  boot: Partial<Record<SettingsQueryCommandName, DecodedFields>>;
  events: readonly ScenarioEvent[];
  untilMs: number;
  commitDelayMs: number;
  neverCommits?: readonly string[];
}): SimulatedStep[] {
  const registers = registersFor(boot);
  const { steps } = simulatePump({
    initial: bootedScheduler({ quietGapAfterWriteMs }, boot),
    registers,
    events,
    fromMs: seconds(100),
    untilMs,
    onSetterSent: commitsLandAfter(registers, commitDelayMs, neverCommits),
  });
  console.log(`  timeline (gap ${quietGapAfterWriteMs}):\n${describeTimeline(steps)}`);
  return steps;
}

function describeTimeline(steps: readonly SimulatedStep[]): string {
  return steps
    .flatMap(step => {
      const at = secondsText(step.endedAtMs);
      if (step.action === "send_setter") {
        return [`    ${at} send ${step.command} → ${step.armed?.strategy} ${step.armed?.quietGapAfterWriteMs} ms`];
      }
      if (step.action === "drop_setter") return [`    ${at} drop ${step.command}`];
      if (step.action === "poll_round") return [];
      const { confirmedChecks, gaveUpChecks, notYetJudgedChecks, retry, starvationFallback } = step.result;
      const verdicts = [
        confirmedChecks.length ? `confirmed ${namesOf(confirmedChecks)}` : "",
        gaveUpChecks.length ? `GAVE UP ${namesOf(gaveUpChecks)}` : "",
        notYetJudgedChecks.length ? `not yet judged ${namesOf(notYetJudgedChecks)}` : "",
        retry ? `next ${secondsText(retry.retryAt)}` : "phase over",
        starvationFallback ? `FALLBACK → ${starvationFallback.quietGapAfterWriteMs} ms` : "",
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
