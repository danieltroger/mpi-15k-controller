/**
 * Pure self-test of the two confirm strategies the quiet gap selects (#52): the default silent one
 * (no traffic until each confirm) and gap 0 (GS/PS polling continues, confirms interleave). The
 * scheduler is driven through the simulated pump of schedulerSimulation.ts against a fake GPMP
 * register that commits at a chosen time — or never. Also the invariants that keep the
 * identical-setter gate, the satisfied-setter drop and per-field trust right while polling
 * continues, and the live knob. The review scenarios of PR #62 are in
 * confirmPhaseScenarios.selftest.ts. Run from backend/ with:
 *   yarn node src/inverterComms/quietGapStrategies.selftest.ts
 */
import process from "process";
import {
  afterConfirmRun,
  afterSetterSent,
  decideNextAction,
  readbackAlreadySatisfies,
  withQuietGapAfterWrite,
  withSettingsReadback,
  type ConfirmOutcome,
  type SchedulerState,
} from "./schedulerCore.ts";
import {
  confirmStrategyFor,
  CONFIRM_BACKOFF_MS,
  DEFAULT_SCHEDULER_TIMING,
  effectiveQuietGapMs,
  FIRST_INTERLEAVED_CONFIRM_AFTER_WRITE_MS,
  IDENTICAL_SETTER_MIN_INTERVAL_MS,
  INTERLEAVED_CONFIRM_GIVE_UP_AFTER_WRITE_MS,
  INTERLEAVED_CONFIRM_INTERVAL_MS,
  MAX_QUIET_GAP_AFTER_WRITE_MS,
  QUIET_GAP_AFTER_WRITE_MS,
} from "./schedulerTiming.ts";
import { LINE_QUIET_BEFORE_SEND_MS, RESPONSE_RETRIES, RESPONSE_TIMEOUT_MS } from "./serialExchange.ts";
import {
  bootedScheduler,
  CONFIRM_QUERY_DURATION_MS,
  confirmRunsIn,
  POLL_ROUND_DURATION_MS,
  queueSetterAt,
  registersFor,
  SETTER_DURATION_MS,
  SETTINGS_POLL_INTERVAL_MS,
  simulatePump,
  type SimulatedStep,
} from "./schedulerSimulation.ts";

const fails: string[] = [];
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name} ${detail}`);
  if (!cond) fails.push(name);
}

const seconds = (value: number) => value * 1000;
const OLD_WATTS = 350;
const NEW_WATTS = 550;
const NEW_TARGET = "GPMP000550";
/** A confirm query that times out on every attempt: the slowest a confirm run gets */
const SLOWEST_CONFIRM_QUERY_MS = (RESPONSE_RETRIES + 1) * RESPONSE_TIMEOUT_MS + LINE_QUIET_BEFORE_SEND_MS;

type SimulatedAction = { action: SimulatedStep["action"]; startedAtMs: number };
type SimulatedConfirm = { endedAtMs: number; result: ConfirmOutcome };
type SimulationResult = {
  state: SchedulerState;
  actions: SimulatedAction[];
  confirms: SimulatedConfirm[];
};

// ---------- defaults and invariants ----------
check(
  "default: a 12 s quiet gap, i.e. the silent strategy (no behaviour change on deploy)",
  DEFAULT_SCHEDULER_TIMING.quietGapAfterWriteMs === 12_000 &&
    QUIET_GAP_AFTER_WRITE_MS === 12_000 &&
    confirmStrategyFor(DEFAULT_SCHEDULER_TIMING.quietGapAfterWriteMs) === "silent" &&
    confirmStrategyFor(0) === "interleaved"
);
check(
  "interleaved: first confirm at ~6 s, then every 3–5 s",
  FIRST_INTERLEAVED_CONFIRM_AFTER_WRITE_MS === 6_000 &&
    INTERLEAVED_CONFIRM_INTERVAL_MS >= 3_000 &&
    INTERLEAVED_CONFIRM_INTERVAL_MS <= 5_000
);
check(
  "interleaved give-up lands before the identical-setter gate (a rewrite can't hide a stuck write)",
  INTERLEAVED_CONFIRM_GIVE_UP_AFTER_WRITE_MS < IDENTICAL_SETTER_MIN_INTERVAL_MS &&
    INTERLEAVED_CONFIRM_GIVE_UP_AFTER_WRITE_MS >= 45_000
);
check(
  "silent verdict at the maximum gap lands before the identical-setter gate too, even with both confirms timing out",
  MAX_QUIET_GAP_AFTER_WRITE_MS + 2 * SLOWEST_CONFIRM_QUERY_MS + CONFIRM_BACKOFF_MS < IDENTICAL_SETTER_MIN_INTERVAL_MS,
  `${MAX_QUIET_GAP_AFTER_WRITE_MS + 2 * SLOWEST_CONFIRM_QUERY_MS + CONFIRM_BACKOFF_MS} ms`
);
{
  const asConfigured = [0, 12_000, MAX_QUIET_GAP_AFTER_WRITE_MS].map(value => effectiveQuietGapMs(value));
  check(
    "effectiveQuietGapMs passes 0, 12000 and the maximum through uncorrected",
    asConfigured.every(
      (effective, index) =>
        effective.correction === undefined && effective.quietGapMs === [0, 12_000, MAX_QUIET_GAP_AFTER_WRITE_MS][index]
    )
  );
  const unusable = [Number.NaN, -1, Infinity].map(value => effectiveQuietGapMs(value));
  check(
    "effectiveQuietGapMs falls back to the 12 s default for NaN / negative / infinite, saying why",
    unusable.every(effective => effective.quietGapMs === QUIET_GAP_AFTER_WRITE_MS && effective.correction !== undefined)
  );
  const tooLong = effectiveQuietGapMs(120_000);
  check(
    "effectiveQuietGapMs clamps an over-long gap to the maximum, saying why",
    tooLong.quietGapMs === MAX_QUIET_GAP_AFTER_WRITE_MS && tooLong.correction !== undefined
  );
}

// ---------- gap 0: polling continues, confirms interleave, the commit at 8 s converges ----------
{
  const writeAt = seconds(100) + SETTER_DURATION_MS;
  const { state, actions, confirms } = simulateWrite(stateWithQuietGap(0), seconds(100), seconds(130), seconds(108));
  const confirmStarts = actionStarts(actions, "run_confirms");
  const pollStarts = actionStarts(actions, "poll_round");
  const confirmedAt = confirms.find(confirm => confirm.result.confirmedChecks.length)?.endedAtMs;
  check(
    "gap 0: GS/PS rounds keep running between the ACK and the first confirm",
    pollStarts.filter(startedAt => startedAt > writeAt && startedAt < confirmStarts[0]!).length >= 4,
    `rounds ${pollStarts.filter(startedAt => startedAt < confirmStarts[0]!).length}`
  );
  check(
    "gap 0: the first confirm runs ~6 s after the write (at most one round late)",
    confirmStarts[0]! >= writeAt + 6_000 && confirmStarts[0]! <= writeAt + 6_000 + POLL_ROUND_DURATION_MS,
    `${confirmStarts[0]! - writeAt} ms`
  );
  check(
    "gap 0: still old at ~6 s → re-checked ~4 s later, which converges",
    confirms.length === 2 &&
      confirms[0]!.result.retry?.pendingChecks.length === 1 &&
      confirms[1]!.result.confirmedChecks[0]?.forCommand === NEW_TARGET &&
      confirmStarts[1]! - confirms[0]!.endedAtMs >= INTERLEAVED_CONFIRM_INTERVAL_MS &&
      confirmStarts[1]! - confirms[0]!.endedAtMs <= INTERLEAVED_CONFIRM_INTERVAL_MS + POLL_ROUND_DURATION_MS,
    `confirms at ${confirmStarts.map(startedAt => startedAt - writeAt).join(", ")} ms after the write`
  );
  check(
    "gap 0: converged → the phase ends with no give-up",
    state.confirm === undefined && confirms.every(confirm => confirm.result.gaveUpChecks.length === 0)
  );
  const longestPollGap = longestGap(pollStarts.filter(startedAt => startedAt <= (confirmedAt ?? 0) + seconds(5)));
  check(
    "gap 0: polling never pauses longer than one round plus a confirm",
    longestPollGap <= POLL_ROUND_DURATION_MS + CONFIRM_QUERY_DURATION_MS + DEFAULT_SCHEDULER_TIMING.pollRoundGapMs,
    `${longestPollGap} ms`
  );
}

// ---------- gap 0: a commit that never lands gives up loudly before the identical-setter gate ----------
{
  const writeAt = seconds(100) + SETTER_DURATION_MS;
  const { state, actions, confirms } = simulateWrite(stateWithQuietGap(0), seconds(100), seconds(180), undefined);
  const gaveUp = confirms.find(confirm => confirm.result.gaveUpChecks.length);
  check(
    "gap 0, never committed: gives up after the 55 s window, before the 60 s identical-setter gate",
    gaveUp !== undefined &&
      gaveUp.endedAtMs >= writeAt + INTERLEAVED_CONFIRM_GIVE_UP_AFTER_WRITE_MS &&
      gaveUp.endedAtMs < writeAt + IDENTICAL_SETTER_MIN_INTERVAL_MS &&
      gaveUp.result.gaveUpChecks[0]?.forCommand === NEW_TARGET,
    gaveUp ? `${gaveUp.endedAtMs - writeAt} ms after the write` : "never gave up"
  );
  const confirmStarts = actionStarts(actions, "run_confirms");
  const recheckGaps = confirmStarts.slice(1, -1).map((startedAt, index) => startedAt - confirms[index]!.endedAtMs);
  check(
    "gap 0, never committed: re-checked every 4 s (+ at most the round in progress) until then",
    confirms.length >= 10 &&
      recheckGaps.every(
        recheckGap =>
          recheckGap >= INTERLEAVED_CONFIRM_INTERVAL_MS &&
          recheckGap <= INTERLEAVED_CONFIRM_INTERVAL_MS + POLL_ROUND_DURATION_MS
      ),
    `${confirms.length} runs, re-check gaps ${recheckGaps.join(", ")} ms`
  );
  const pollStarts = actionStarts(actions, "poll_round");
  check(
    "gap 0, never committed: polling ran throughout and carries on after the give-up",
    pollStarts.filter(startedAt => startedAt > writeAt && startedAt < gaveUp!.endedAtMs).length >= 35 &&
      pollStarts.some(startedAt => startedAt > gaveUp!.endedAtMs) &&
      state.confirm === undefined &&
      confirms.at(-1) === gaveUp
  );
}

// ---------- the default (silent) strategy is unchanged ----------
{
  const writeAt = seconds(100) + SETTER_DURATION_MS;
  const { actions, confirms } = simulateWrite(
    stateWithQuietGap(QUIET_GAP_AFTER_WRITE_MS),
    seconds(100),
    seconds(130),
    seconds(108)
  );
  const confirmStarts = actionStarts(actions, "run_confirms");
  const pollStarts = actionStarts(actions, "poll_round");
  check(
    "default: no poll round between the ACK and the confirm at exactly +12 s",
    confirmStarts[0] === writeAt + QUIET_GAP_AFTER_WRITE_MS &&
      !pollStarts.some(startedAt => startedAt > writeAt && startedAt < confirmStarts[0]!),
    `confirm at +${confirmStarts[0]! - writeAt} ms`
  );
  check(
    "default: the commit at 8 s is confirmed by that one confirm, then polling resumes",
    confirms.length === 1 &&
      confirms[0]!.result.confirmedChecks.length === 1 &&
      pollStarts.some(startedAt => startedAt > confirmStarts[0]!)
  );
}
{
  const writeAt = seconds(100) + SETTER_DURATION_MS;
  const { actions, confirms } = simulateWrite(
    stateWithQuietGap(QUIET_GAP_AFTER_WRITE_MS),
    seconds(100),
    seconds(180),
    undefined
  );
  const pollStarts = actionStarts(actions, "poll_round");
  const gaveUp = confirms.find(confirm => confirm.result.gaveUpChecks.length);
  check(
    "default, never committed: one silent backoff re-check, then the give-up — no polls before it",
    confirms.length === 2 &&
      gaveUp === confirms[1] &&
      !pollStarts.some(startedAt => startedAt > writeAt && startedAt < gaveUp.endedAtMs),
    `${confirms.length} confirm runs`
  );
}

// ---------- gap 0: the identical-setter gate and the satisfied-setter drop ----------
{
  // The consumer re-queues its target right after the ACK (its effect re-runs on the old readback)
  const requeueAt = seconds(100) + SETTER_DURATION_MS + 500;
  const committing = simulateWrite(stateWithQuietGap(0), seconds(100), seconds(130), seconds(108), requeueAt);
  check(
    "gap 0, committed: the identical re-queue is withdrawn once the confirm shows it — never sent again",
    actionStarts(committing.actions, "send_setter").length === 1 &&
      actionStarts(committing.actions, "drop_setter").length === 1 &&
      committing.state.queuedSetters.length === 0
  );
  const stuck = simulateWrite(stateWithQuietGap(0), seconds(100), seconds(170), undefined, requeueAt);
  const sends = actionStarts(stuck.actions, "send_setter");
  const gaveUp = stuck.confirms.find(confirm => confirm.result.gaveUpChecks.length);
  const gateOpensAt = seconds(100) + SETTER_DURATION_MS + IDENTICAL_SETTER_MIN_INTERVAL_MS;
  check(
    "gap 0, stuck: the give-up comes first, the identical rewrite only when its 60 s gate opens",
    gaveUp !== undefined &&
      sends.length === 2 &&
      sends[1]! >= gateOpensAt &&
      sends[1]! <= gateOpensAt + POLL_ROUND_DURATION_MS &&
      gaveUp.endedAtMs < gateOpensAt,
    `sends at ${sends.join(", ")}, give-up at ${gaveUp?.endedAtMs}`
  );
}
{
  // Per-field trust while polling continues: a readback decoded during the phase can't vouch yet
  let state = withSettingsReadback(stateWithQuietGap(0), "GPMP", { maximum_feeding_grid_power: OLD_WATTS }, seconds(1));
  state = afterSetterSent(state, NEW_TARGET, ["GPMP"], seconds(2), true);
  state = withSettingsReadback(state, "GPMP", { maximum_feeding_grid_power: OLD_WATTS }, seconds(4));
  check(
    "gap 0: a background readback during the phase doesn't satisfy the old target while the confirm is pending",
    !readbackAlreadySatisfies(state, "GPMP000350")
  );
  check("gap 0: …nor the new one, though it is decoded after the write", !readbackAlreadySatisfies(state, NEW_TARGET));
  state = withSettingsReadback(state, "GPMP", { maximum_feeding_grid_power: NEW_WATTS }, seconds(8));
  state = afterConfirmRun(state, { GPMP: { maximum_feeding_grid_power: NEW_WATTS } }, seconds(8)).state;
  check("gap 0: once confirmed, the readback vouches for the new target", readbackAlreadySatisfies(state, NEW_TARGET));
}

// ---------- gap 0: a burst — each check gives up at its own deadline, the cadence keeps going ----------
{
  let state = stateWithQuietGap(0);
  state = afterSetterSent(state, "EDF1", ["HECS"], seconds(0), true);
  state = afterSetterSent(state, "EDG1", ["HECS"], seconds(5), true);
  check(
    "gap 0: a second write keeps the first one's confirm slot (no pushing it out)",
    state.confirm?.dueAt === seconds(6),
    `due ${state.confirm?.dueAt}`
  );
  const neitherApplied = {
    HECS: {
      battery_discharge_to_feed_grid_when_solar_input_normal: "disabled",
      battery_discharge_to_feed_grid_when_solar_input_loss: "disabled",
    },
  };
  const firstRun = afterConfirmRun(state, neitherApplied, seconds(6));
  check(
    "gap 0: the 6 s run judges EDF1 only — EDG1 (written at 5 s) is not judged before its own 6 s",
    firstRun.result.notYetJudgedChecks.map(youngCheck => youngCheck.forCommand).join() === "EDG1" &&
      firstRun.result.retry?.pendingChecks.length === 2 &&
      firstRun.result.retry.retryAt === seconds(10),
    JSON.stringify(firstRun.result.retry?.retryAt)
  );
  state = firstRun.state;
  for (let confirmAtSeconds = 10; confirmAtSeconds < 55; confirmAtSeconds += 4) {
    state = afterConfirmRun(state, neitherApplied, seconds(confirmAtSeconds)).state;
  }
  const atFirstDeadline = afterConfirmRun(state, neitherApplied, seconds(55));
  check(
    "gap 0: EDF1 gives up at its own 55 s deadline while EDG1 (written 5 s later) is still re-checked",
    atFirstDeadline.result.gaveUpChecks.map(gaveUpCheck => gaveUpCheck.forCommand).join() === "EDF1" &&
      atFirstDeadline.result.retry?.pendingChecks.map(pendingCheck => pendingCheck.forCommand).join() === "EDG1" &&
      atFirstDeadline.result.retry.retryAt === seconds(59),
    JSON.stringify(atFirstDeadline.result.retry?.retryAt)
  );
}

// ---------- gap 0: re-checks narrow to the pending checks' queries; silent keeps its union ----------
{
  const bothQueries = { GPMP: { maximum_feeding_grid_power: NEW_WATTS }, BATS: { "max._ac_charging_current": 6 } };
  const interleaved = afterSetterSent(
    afterSetterSent(stateWithQuietGap(0), NEW_TARGET, ["GPMP"], seconds(0), true),
    "MUCHGC0100",
    ["BATS"],
    seconds(1),
    true
  );
  const afterInterleavedRun = afterConfirmRun(interleaved, bothQueries, seconds(7)).state;
  check(
    "gap 0: GPMP confirmed, MUCHGC still old → the re-check queries BATS only",
    afterInterleavedRun.confirm?.queries.join() === "BATS",
    JSON.stringify(afterInterleavedRun.confirm?.queries)
  );
  const silent = afterSetterSent(
    afterSetterSent(stateWithQuietGap(QUIET_GAP_AFTER_WRITE_MS), NEW_TARGET, ["GPMP"], seconds(0), true),
    "MUCHGC0100",
    ["BATS"],
    seconds(1),
    true
  );
  const afterSilentRun = afterConfirmRun(silent, bothQueries, seconds(13)).state;
  check(
    "default: the silent backoff re-check keeps the phase's full query union (wire unchanged)",
    afterSilentRun.confirm?.queries.join() === "GPMP,BATS",
    JSON.stringify(afterSilentRun.confirm?.queries)
  );
}

// ---------- the live knob: a running phase keeps its gap and strategy ----------
{
  let state = stateWithQuietGap(QUIET_GAP_AFTER_WRITE_MS);
  state = afterSetterSent(state, NEW_TARGET, ["GPMP"], seconds(10), true);
  state = withQuietGapAfterWrite(state, 0);
  const duringSilentPhase = decideNextAction(state, seconds(11), SETTINGS_POLL_INTERVAL_MS);
  check(
    "knob → 0 during a silent phase: that phase stays silent",
    duringSilentPhase.action === "wait" && duringSilentPhase.reason === "quiet gap after write"
  );
  state = afterSetterSent(state, "EDF1", ["HECS"], seconds(12), true);
  check(
    "knob → 0: a write merging into the silent phase keeps its 12 s silence (not cut short)",
    state.confirm?.strategy === "silent" &&
      state.confirm.quietGapAfterWriteMs === QUIET_GAP_AFTER_WRITE_MS &&
      state.confirm.dueAt === seconds(24)
  );
  const applied = {
    GPMP: { maximum_feeding_grid_power: NEW_WATTS },
    HECS: { battery_discharge_to_feed_grid_when_solar_input_normal: "enabled" },
  };
  state = afterConfirmRun(state, applied, seconds(24)).state;
  state = afterSetterSent(state, "EDG1", ["HECS"], seconds(30), true);
  check(
    "knob → 0: the first write after that phase arms the interleaved strategy",
    state.confirm?.strategy === "interleaved" &&
      state.confirm.quietGapAfterWriteMs === 0 &&
      state.confirm.dueAt === seconds(36)
  );
  state = withQuietGapAfterWrite(state, 3_000);
  state = afterSetterSent(state, "EDB1", ["HECS"], seconds(31), true);
  check(
    "knob → 3000: a write merging into the interleaved phase stays interleaved, on its own 6 s",
    state.confirm?.strategy === "interleaved" && state.confirm.dueAt === seconds(36)
  );
}

console.log(
  `\n${fails.length ? `${fails.length} FAILED: ${fails.join(", ")}` : "all quietGapStrategies selftests passed"}`
);
process.exit(fails.length ? 1 : 0);

/** A scheduler that has finished its boot round (with the settings poll), so only GS+PS rounds follow */
function stateWithQuietGap(quietGapAfterWriteMs: number): SchedulerState {
  return bootedScheduler({ quietGapAfterWriteMs }, { GPMP: { maximum_feeding_grid_power: OLD_WATTS } });
}

/**
 * Queue NEW_TARGET at `queuedAtMs` (and, optionally, the identical command again at `requeueAtMs`)
 * and run the pump until `untilMs` against a GPMP register that switches to NEW_WATTS at
 * `commitAtMs` — or never.
 */
function simulateWrite(
  initial: SchedulerState,
  queuedAtMs: number,
  untilMs: number,
  commitAtMs: number | undefined,
  requeueAtMs?: number
): SimulationResult {
  const registers = registersFor({ GPMP: { maximum_feeding_grid_power: OLD_WATTS } });
  if (commitAtMs !== undefined) registers[0]!.commits.push({ atMs: commitAtMs, value: NEW_WATTS });
  const events = [queueSetterAt(queuedAtMs, NEW_TARGET, "GPMP0")];
  if (requeueAtMs !== undefined) events.push(queueSetterAt(requeueAtMs, NEW_TARGET, "GPMP0"));
  const { state, steps } = simulatePump({ initial, registers, events, fromMs: queuedAtMs, untilMs });
  return {
    state,
    actions: steps.map(step => ({ action: step.action, startedAtMs: step.startedAtMs })),
    confirms: confirmRunsIn(steps).map(run => ({ endedAtMs: run.endedAtMs, result: run.result })),
  };
}

function actionStarts(actions: readonly SimulatedAction[], action: SimulatedAction["action"]): number[] {
  return actions.filter(simulated => simulated.action === action).map(simulated => simulated.startedAtMs);
}

function longestGap(times: readonly number[]): number {
  return Math.max(0, ...times.slice(1).map((time, index) => time - times[index]!));
}
