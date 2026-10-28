/**
 * Pure self-test for the session scheduling brain: setter→readback mapping, and the confirm
 * state machine (write → polling continues → confirm → converged/re-check/give-up) with the
 * identical-setter gate. No hardware, no timers — everything runs on fake timestamps. Run from backend/ with:
 *   yarn node src/inverterComms/inverterScheduling.selftest.ts
 */
import process from "process";
import { checkIsSatisfied, expectedReadbackChecksForSetter } from "./setterConfirmation.ts";
import {
  afterConfirmRun,
  afterPollRound,
  afterSetterSent,
  decideNextAction,
  initialSchedulerState,
  withSetterDequeued,
  withSetterQueued,
} from "./schedulerCore.ts";
import {
  CONFIRM_GIVE_UP_AFTER_WRITE_MS,
  CONFIRM_RECHECK_INTERVAL_MS,
  DEFAULT_SCHEDULER_TIMING,
  FIRST_CONFIRM_AFTER_WRITE_MS,
  IDENTICAL_SETTER_MIN_INTERVAL_MS,
  POLL_ROUND_GAP_AFTER_FAILURE_MS,
  POLL_ROUND_GAP_MS,
} from "./schedulerTiming.ts";
import { classifyFrame } from "./pi17Frames.ts";
import { decodeQueryPayload } from "./pi17Decode.ts";

const fails: string[] = [];
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name} ${detail}`);
  if (!cond) fails.push(name);
}

const SETTINGS_POLL_INTERVAL_MS = 300_000;

// ---------- expectedReadbackChecksForSetter ----------
{
  const checks = expectedReadbackChecksForSetter("MCHGV0580,0580");
  check(
    "MCHGV maps to both BATS voltage fields",
    checks.length === 2 &&
      checks[0]!.query === "BATS" &&
      checks[0]!.field === "battery_constant_charge_voltage(c.v.)" &&
      checks[0]!.expectedValue === 58 &&
      checks[1]!.field === "battery_floating_charge_voltage" &&
      checks[1]!.expectedValue === 58
  );
}
{
  const checks = expectedReadbackChecksForSetter("MUCHGC0100");
  check(
    "MUCHGC maps to BATS max AC charging current in amps",
    checks.length === 1 &&
      checks[0]!.query === "BATS" &&
      checks[0]!.field === "max._ac_charging_current" &&
      checks[0]!.expectedValue === 10
  );
}
{
  const checks = expectedReadbackChecksForSetter("GPMP015000");
  check(
    "GPMP0 maps to the GPMP readback",
    checks.length === 1 &&
      checks[0]!.query === "GPMP" &&
      checks[0]!.field === "maximum_feeding_grid_power" &&
      checks[0]!.expectedValue === 15000
  );
}
{
  const edb = expectedReadbackChecksForSetter("EDB1");
  const edg = expectedReadbackChecksForSetter("EDG0");
  check(
    "EDB1 maps to HECS ac_charge_battery enabled",
    edb.length === 1 && edb[0]!.field === "ac_charge_battery" && edb[0]!.expectedValue === "enabled"
  );
  check(
    "EDG0 maps to HECS feed-grid-when-solar-loss disabled",
    edg.length === 1 &&
      edg[0]!.field === "battery_discharge_to_feed_grid_when_solar_input_loss" &&
      edg[0]!.expectedValue === "disabled"
  );
}
check("unknown setter has no readback checks", expectedReadbackChecksForSetter("DAT260718120000").length === 0);

// End-to-end against a real captured BATS response: the fields the confirm compares are the very
// fields the decoder produces (a renamed table entry would break this — loudly, here).
{
  const bats = classifyFrame(
    Buffer.from("^D0763000,0580,0580,0000,060,0530,0400,0510,0460,0522,0,,,0,0530,000,0100,0375\xcc\x14\r", "latin1")
  );
  if (bats.kind !== "data") throw new Error("BATS fixture did not classify");
  const decodedByQuery = { BATS: decodeQueryPayload("BATS", bats.payloadText).fields };
  const [cvCheck, floatCheck] = expectedReadbackChecksForSetter("MCHGV0580,0580");
  check(
    "MCHGV0580,0580 confirms against live BATS 58.0/58.0",
    checkIsSatisfied(cvCheck!, decodedByQuery) && checkIsSatisfied(floatCheck!, decodedByQuery)
  );
  const [staleCvCheck] = expectedReadbackChecksForSetter("MCHGV0570,0570");
  check(
    "MCHGV0570,0570 does NOT confirm against live BATS 58.0/58.0",
    !checkIsSatisfied(staleCvCheck!, decodedByQuery)
  );
  const [amperageCheck] = expectedReadbackChecksForSetter("MUCHGC0100");
  check("MUCHGC0100 confirms against live BATS (10.0 A)", checkIsSatisfied(amperageCheck!, decodedByQuery));
  check("missing query counts as unconfirmed", !checkIsSatisfied(cvCheck!, {}));
}

// ---------- the confirm state machine ----------
const bootTime = 1_000_000;
{
  let state = initialSchedulerState();
  // Boot: poll immediately, including the settings queries
  const bootDecision = decideNextAction(state, bootTime, SETTINGS_POLL_INTERVAL_MS);
  check("boot decision is a full poll round", bootDecision.action === "poll_round" && bootDecision.includeSettingsPoll);
  const bootRoundEndedAt = bootTime + 1_900; // GS+PS+GPMP+HECS+BATS at 2400 baud
  state = afterPollRound(state, {
    startedAtMs: bootTime,
    endedAtMs: bootRoundEndedAt,
    includedSettingsPoll: true,
    hadFailures: false,
  });

  // Pacing: rounds run back-to-back — the next one is due POLL_ROUND_GAP_MS after the last one ENDED
  check("poll rounds are paced back-to-back (gap well under the old 2 s pace)", POLL_ROUND_GAP_MS <= 100);
  const pacingDecision = decideNextAction(state, bootRoundEndedAt + 10, SETTINGS_POLL_INTERVAL_MS);
  check(
    "poll pacing waits only the minimal gap after the round ended",
    pacingDecision.action === "wait" && pacingDecision.untilMs === bootRoundEndedAt + POLL_ROUND_GAP_MS
  );
  const nextRoundDecision = decideNextAction(state, bootRoundEndedAt + POLL_ROUND_GAP_MS, SETTINGS_POLL_INTERVAL_MS);
  check(
    "settings poll not due again until its interval elapses",
    nextRoundDecision.action === "poll_round" && !nextRoundDecision.includeSettingsPoll
  );
  const settingsDue = decideNextAction(state, bootTime + SETTINGS_POLL_INTERVAL_MS, SETTINGS_POLL_INTERVAL_MS);
  check("settings poll due after its interval", settingsDue.action === "poll_round" && settingsDue.includeSettingsPoll);

  // A queued control write preempts everything
  state = withSetterQueued(state, "MCHGV0580,0580", "MCHGV", bootTime + 1_000);
  const setterDecision = decideNextAction(state, bootTime + 1_000, SETTINGS_POLL_INTERVAL_MS);
  check(
    "queued setter is sent before polls",
    setterDecision.action === "send_setter" && setterDecision.command === "MCHGV0580,0580"
  );

  // Send it: polling carries on, the confirm is scheduled
  state = withSetterDequeued(state, "MCHGV0580,0580");
  check("dequeue removes the sent setter", state.queuedSetters.length === 0);
  const sentAt = bootTime + 1_200;
  state = afterSetterSent(state, "MCHGV0580,0580", ["BATS"], sentAt, true);
  state = afterPollRound(state, {
    startedAtMs: bootTime + 100,
    endedAtMs: sentAt,
    includedSettingsPoll: false,
    hadFailures: false,
  });
  const afterWriteDecision = decideNextAction(state, sentAt + POLL_ROUND_GAP_MS, SETTINGS_POLL_INTERVAL_MS);
  check("polling continues right after a write", afterWriteDecision.action === "poll_round");
  check("the first confirm is due 9 s after the write", state.confirm?.dueAt === sentAt + FIRST_CONFIRM_AFTER_WRITE_MS);
  const confirmDecision = decideNextAction(state, sentAt + FIRST_CONFIRM_AFTER_WRITE_MS, SETTINGS_POLL_INTERVAL_MS);
  check(
    "the confirm query runs when due, ahead of the next poll round",
    confirmDecision.action === "run_confirms" &&
      confirmDecision.queries.length === 1 &&
      confirmDecision.queries[0] === "BATS"
  );

  // Readback still shows the old values → re-checked every 4 s, polling in between
  const staleReadback = { BATS: { "battery_constant_charge_voltage(c.v.)": 57, battery_floating_charge_voltage: 57 } };
  let confirmTime = sentAt + FIRST_CONFIRM_AFTER_WRITE_MS + 300;
  const retryResult = afterConfirmRun(state, staleReadback, confirmTime);
  state = retryResult.state;
  check(
    "an unconfirmed write is re-checked 4 s later",
    retryResult.result.retry?.retryAt === confirmTime + CONFIRM_RECHECK_INTERVAL_MS &&
      retryResult.result.retry.pendingChecks.length === 2 &&
      retryResult.result.gaveUpChecks.length === 0
  );
  const betweenDecision = decideNextAction(state, confirmTime + 1_000, SETTINGS_POLL_INTERVAL_MS);
  check("polling continues between the re-checks", betweenDecision.action === "poll_round");

  // Still old at its 55 s give-up → give up loudly, polling carries on
  let reChecks = 0;
  while (state.confirm && confirmTime < sentAt + CONFIRM_GIVE_UP_AFTER_WRITE_MS) {
    confirmTime = state.confirm.dueAt;
    const run = afterConfirmRun(state, staleReadback, confirmTime);
    state = run.state;
    reChecks++;
    if (run.result.gaveUpChecks.length) {
      check(
        "a write still old at its 55 s give-up gives up — never past it",
        confirmTime === sentAt + CONFIRM_GIVE_UP_AFTER_WRITE_MS &&
          run.result.retry === undefined &&
          run.result.gaveUpChecks.length === 2,
        `gave up ${confirmTime - sentAt} ms after the write, after ${reChecks} re-checks`
      );
    }
  }
  check("give-up clears the confirm phase", state.confirm === undefined);
  const afterGiveUp = decideNextAction(state, confirmTime + 10, SETTINGS_POLL_INTERVAL_MS);
  check("polling carries on after the give-up", afterGiveUp.action === "poll_round");

  // The identical-setter gate: the same command can't go out again within 60 s of the last send
  const requeueTime = confirmTime + 1_000;
  state = withSetterQueued(state, "MCHGV0580,0580", "MCHGV", requeueTime);
  check(
    "identical setter is gated to sentAt + 60 s",
    state.queuedSetters[0]!.notBefore === sentAt + IDENTICAL_SETTER_MIN_INTERVAL_MS
  );
  const gatedDecision = decideNextAction(state, requeueTime, SETTINGS_POLL_INTERVAL_MS);
  check("gated setter does not send early (polls continue)", gatedDecision.action === "poll_round");
  state = afterPollRound(state, {
    startedAtMs: requeueTime - 1_000,
    endedAtMs: requeueTime,
    includedSettingsPoll: false,
    hadFailures: false,
  });
  const waitForGate = decideNextAction(state, requeueTime + POLL_ROUND_GAP_MS / 2, SETTINGS_POLL_INTERVAL_MS);
  check(
    "wait wakes no later than the gate opening",
    waitForGate.action === "wait" && waitForGate.untilMs <= sentAt + IDENTICAL_SETTER_MIN_INTERVAL_MS
  );
  const gateOpen = decideNextAction(state, sentAt + IDENTICAL_SETTER_MIN_INTERVAL_MS, SETTINGS_POLL_INTERVAL_MS);
  check(
    "gate opens exactly at 60 s after the last send",
    gateOpen.action === "send_setter" && gateOpen.command === "MCHGV0580,0580"
  );

  // A different value for the same prefix replaces the queued command and is NOT gated
  state = withSetterQueued(state, "MCHGV0575,0575", "MCHGV", requeueTime + 2_000);
  check(
    "same-prefix replacement drops the stale queued setter",
    state.queuedSetters.length === 1 &&
      state.queuedSetters[0]!.command === "MCHGV0575,0575" &&
      state.queuedSetters[0]!.notBefore === requeueTime + 2_000
  );
}

// ---------- a round with a failed query backs off before the next ----------
{
  let state = initialSchedulerState();
  state = afterPollRound(state, {
    startedAtMs: bootTime,
    endedAtMs: bootTime + 13_000,
    includedSettingsPoll: false,
    hadFailures: true,
  });
  const decision = decideNextAction(state, bootTime + 13_000 + POLL_ROUND_GAP_MS, SETTINGS_POLL_INTERVAL_MS);
  check(
    "failed round waits the longer failure gap",
    decision.action === "wait" && decision.untilMs === bootTime + 13_000 + POLL_ROUND_GAP_AFTER_FAILURE_MS
  );
}

// ---------- timing: production defaults are the measured constants; overrides are harness-only ----------
{
  check(
    "default timing: first confirm 9 s after the write (#52), re-checks every 4 s, give-up at 55 s",
    DEFAULT_SCHEDULER_TIMING.firstConfirmAfterWriteMs === FIRST_CONFIRM_AFTER_WRITE_MS &&
      FIRST_CONFIRM_AFTER_WRITE_MS === 9_000 &&
      DEFAULT_SCHEDULER_TIMING.confirmRecheckIntervalMs === CONFIRM_RECHECK_INTERVAL_MS &&
      CONFIRM_RECHECK_INTERVAL_MS === 4_000 &&
      DEFAULT_SCHEDULER_TIMING.confirmGiveUpAfterWriteMs === CONFIRM_GIVE_UP_AFTER_WRITE_MS &&
      CONFIRM_GIVE_UP_AFTER_WRITE_MS === 55_000
  );
  check(
    "the give-up lands before the identical-setter gate opens (a rewrite would replace the pending check)",
    CONFIRM_GIVE_UP_AFTER_WRITE_MS < IDENTICAL_SETTER_MIN_INTERVAL_MS
  );
  check(
    "initialSchedulerState() without overrides uses the defaults",
    initialSchedulerState().timing.firstConfirmAfterWriteMs === FIRST_CONFIRM_AFTER_WRITE_MS
  );
  let state = initialSchedulerState({ firstConfirmAfterWriteMs: 1_500, confirmRecheckIntervalMs: 3_000 });
  state = afterSetterSent(state, "GPMP000950", ["GPMP"], bootTime, true);
  check("first-confirm override is honoured", state.confirm!.dueAt === bootTime + 1_500);
  const retry = afterConfirmRun(state, { GPMP: { maximum_feeding_grid_power: 350 } }, bootTime + 1_600);
  check("re-check override is honoured", retry.result.retry?.retryAt === bootTime + 1_600 + 3_000);
}

// ---------- multi-setter bursts merge into one confirm phase ----------
{
  let state = initialSchedulerState();
  const firstSentAt = bootTime + 100;
  state = afterSetterSent(state, "EDF1", ["HECS"], firstSentAt, true);
  const secondSentAt = bootTime + 1_300;
  state = afterSetterSent(state, "EDG1", ["HECS"], secondSentAt, true);
  check(
    "a burst keeps the first write's confirm due (a stream of writes can't push it out)",
    state.confirm!.dueAt === firstSentAt + FIRST_CONFIRM_AFTER_WRITE_MS
  );
  check(
    "burst merges confirm queries without duplicates",
    state.confirm!.queries.length === 1 && state.confirm!.queries[0] === "HECS"
  );
  check("burst keeps both setters' checks", state.confirm!.checks.length === 2);
  const bothApplied = {
    HECS: {
      battery_discharge_to_feed_grid_when_solar_input_normal: "enabled",
      battery_discharge_to_feed_grid_when_solar_input_loss: "enabled",
    },
  };
  const converged = afterConfirmRun(state, bothApplied, secondSentAt + FIRST_CONFIRM_AFTER_WRITE_MS);
  check(
    "burst converges when both readbacks match",
    converged.result.confirmedChecks.length === 2 &&
      converged.result.retry === undefined &&
      converged.state.confirm === undefined
  );
}

// ---------- superseding a write replaces its pending checks ----------
{
  let state = initialSchedulerState();
  state = afterSetterSent(state, "MCHGV0570,0570", ["BATS"], bootTime, true);
  state = afterSetterSent(state, "MCHGV0580,0580", ["BATS"], bootTime + 65_000, true);
  check(
    "superseding write replaces the old expectation",
    state.confirm!.checks.length === 2 &&
      state.confirm!.checks.every(readbackCheck => readbackCheck.expectedValue === 58)
  );
}

// ---------- NAK/timeout path: a readback but no convergence expectation ----------
{
  let state = initialSchedulerState();
  state = afterSetterSent(state, "MCHGV0580,0580", ["BATS"], bootTime, false);
  check(
    "unacknowledged write still schedules the confirm readback",
    state.confirm !== undefined && state.confirm.dueAt === bootTime + FIRST_CONFIRM_AFTER_WRITE_MS
  );
  check(
    "unacknowledged write has refresh queries but no checks",
    state.confirm!.queries.length === 1 && state.confirm!.checks.length === 0
  );
  const vacuous = afterConfirmRun(state, {}, bootTime + FIRST_CONFIRM_AFTER_WRITE_MS);
  check(
    "checkless confirm converges vacuously (no false 'never applied' alarm)",
    vacuous.result.gaveUpChecks.length === 0 &&
      vacuous.result.retry === undefined &&
      vacuous.state.confirm === undefined
  );
}

console.log(
  `\n${fails.length ? `${fails.length} FAILED: ${fails.join(", ")}` : "all inverterScheduling selftests passed"}`
);
process.exit(fails.length ? 1 : 0);
