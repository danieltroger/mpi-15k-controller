/**
 * Pure self-test of the confirm cadence (#52): GS/PS polling continues through every write, and its
 * confirm readbacks slot in between the poll rounds — first 9 s after the write, then every 4 s,
 * giving up at 55 s. The scheduler is driven through the simulated pump of schedulerSimulation.ts
 * against a fake GPMP register that commits at a chosen time — or never. Also the invariants that keep
 * the identical-setter gate, the satisfied-setter drop and per-field trust right while polling
 * continues. The review scenarios of PR #62 are in confirmPhaseScenarios.selftest.ts. Run from
 * backend/ with:
 *   yarn node src/inverterComms/confirmCadence.selftest.ts
 */
import process from "process";
import {
  afterConfirmRun,
  afterSetterSent,
  readbackAlreadySatisfies,
  withSettingsReadback,
  type SchedulerState,
} from "./schedulerCore.ts";
import type { ConfirmVerdicts } from "./confirmVerdicts.ts";
import {
  CONFIRM_GIVE_UP_AFTER_WRITE_MS,
  CONFIRM_RECHECK_INTERVAL_MS,
  DEFAULT_SCHEDULER_TIMING,
  FIRST_CONFIRM_AFTER_WRITE_MS,
  IDENTICAL_SETTER_MIN_INTERVAL_MS,
} from "./schedulerTiming.ts";
import {
  bootedScheduler,
  CONFIRM_QUERY_DURATION_MS,
  confirmRunsIn,
  POLL_ROUND_DURATION_MS,
  queueSetterAt,
  registersFor,
  SETTER_DURATION_MS,
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

type SimulatedAction = { action: SimulatedStep["action"]; startedAtMs: number };
type SimulatedConfirm = { endedAtMs: number; result: ConfirmVerdicts };
type SimulationResult = {
  state: SchedulerState;
  actions: SimulatedAction[];
  confirms: SimulatedConfirm[];
};

// ---------- defaults and invariants ----------
check(
  "first confirm at 9 s (#52: commits landed 6.2–11.5 s after the ACK, one by 9.2 s), then every 3–5 s",
  DEFAULT_SCHEDULER_TIMING.firstConfirmAfterWriteMs === FIRST_CONFIRM_AFTER_WRITE_MS &&
    FIRST_CONFIRM_AFTER_WRITE_MS === 9_000 &&
    CONFIRM_RECHECK_INTERVAL_MS >= 3_000 &&
    CONFIRM_RECHECK_INTERVAL_MS <= 5_000
);
check(
  "the give-up lands before the identical-setter gate (a rewrite can't hide a stuck write)",
  CONFIRM_GIVE_UP_AFTER_WRITE_MS < IDENTICAL_SETTER_MIN_INTERVAL_MS && CONFIRM_GIVE_UP_AFTER_WRITE_MS >= 45_000
);

// ---------- polling continues, confirms slot in; an 8 s commit converges on the first ----------
{
  const writeAt = seconds(100) + SETTER_DURATION_MS;
  const { state, actions, confirms } = simulateWrite(bootedState(), seconds(100), seconds(130), seconds(108));
  const confirmStarts = actionStarts(actions, "run_confirms");
  const pollStarts = actionStarts(actions, "poll_round");
  const confirmedAt = confirms.find(confirm => confirm.result.confirmedChecks.length)?.endedAtMs;
  check(
    "GS/PS rounds keep running between the ACK and the first confirm",
    pollStarts.filter(startedAt => startedAt > writeAt && startedAt < confirmStarts[0]!).length >= 4,
    `rounds ${pollStarts.filter(startedAt => startedAt < confirmStarts[0]!).length}`
  );
  check(
    "the first confirm runs ~9 s after the write (at most one round late)",
    confirmStarts[0]! >= writeAt + FIRST_CONFIRM_AFTER_WRITE_MS &&
      confirmStarts[0]! <= writeAt + FIRST_CONFIRM_AFTER_WRITE_MS + POLL_ROUND_DURATION_MS,
    `${confirmStarts[0]! - writeAt} ms`
  );
  check(
    "the 8 s commit is confirmed by that first confirm — no re-check",
    confirms.length === 1 && confirms[0]!.result.confirmedChecks[0]?.forCommand === NEW_TARGET,
    `confirms at ${confirmStarts.map(startedAt => startedAt - writeAt).join(", ")} ms after the write`
  );
  check(
    "converged → the phase ends with no give-up",
    state.confirm === undefined && confirms.every(confirm => confirm.result.gaveUpChecks.length === 0)
  );
  const longestPollGap = longestGap(pollStarts.filter(startedAt => startedAt <= (confirmedAt ?? 0) + seconds(5)));
  check(
    "polling never pauses longer than one round plus a confirm",
    longestPollGap <= POLL_ROUND_DURATION_MS + CONFIRM_QUERY_DURATION_MS + DEFAULT_SCHEDULER_TIMING.pollRoundGapMs,
    `${longestPollGap} ms`
  );
}

{
  // #52's slowest commits (~11 s): still old at the first confirm, confirmed ~4 s later
  const writeAt = seconds(100) + SETTER_DURATION_MS;
  const { actions, confirms } = simulateWrite(bootedState(), seconds(100), seconds(130), seconds(111.5));
  const confirmStarts = actionStarts(actions, "run_confirms");
  check(
    "an 11.5 s commit is still old at ~9 s → re-checked ~4 s later, which converges",
    confirms.length === 2 &&
      confirms[0]!.result.retry?.pendingChecks.length === 1 &&
      confirms[1]!.result.confirmedChecks[0]?.forCommand === NEW_TARGET &&
      confirmStarts[1]! - confirms[0]!.endedAtMs >= CONFIRM_RECHECK_INTERVAL_MS &&
      confirmStarts[1]! - confirms[0]!.endedAtMs <= CONFIRM_RECHECK_INTERVAL_MS + POLL_ROUND_DURATION_MS,
    `confirms at ${confirmStarts.map(startedAt => startedAt - writeAt).join(", ")} ms after the write`
  );
}

// ---------- a commit that never lands gives up loudly before the identical-setter gate ----------
{
  const writeAt = seconds(100) + SETTER_DURATION_MS;
  const { state, actions, confirms } = simulateWrite(bootedState(), seconds(100), seconds(180), undefined);
  const gaveUp = confirms.find(confirm => confirm.result.gaveUpChecks.length);
  check(
    "never committed: gives up after the 55 s window, before the 60 s identical-setter gate",
    gaveUp !== undefined &&
      gaveUp.endedAtMs >= writeAt + CONFIRM_GIVE_UP_AFTER_WRITE_MS &&
      gaveUp.endedAtMs < writeAt + IDENTICAL_SETTER_MIN_INTERVAL_MS &&
      gaveUp.result.gaveUpChecks[0]?.forCommand === NEW_TARGET,
    gaveUp ? `${gaveUp.endedAtMs - writeAt} ms after the write` : "never gave up"
  );
  const confirmStarts = actionStarts(actions, "run_confirms");
  const recheckGaps = confirmStarts.slice(1, -1).map((startedAt, index) => startedAt - confirms[index]!.endedAtMs);
  check(
    "never committed: re-checked every 4 s (+ at most the round in progress) until then",
    confirms.length >= 10 &&
      recheckGaps.every(
        recheckGap =>
          recheckGap >= CONFIRM_RECHECK_INTERVAL_MS &&
          recheckGap <= CONFIRM_RECHECK_INTERVAL_MS + POLL_ROUND_DURATION_MS
      ),
    `${confirms.length} runs, re-check gaps ${recheckGaps.join(", ")} ms`
  );
  const pollStarts = actionStarts(actions, "poll_round");
  check(
    "never committed: polling ran throughout and carries on after the give-up",
    pollStarts.filter(startedAt => startedAt > writeAt && startedAt < gaveUp!.endedAtMs).length >= 35 &&
      pollStarts.some(startedAt => startedAt > gaveUp!.endedAtMs) &&
      state.confirm === undefined &&
      confirms.at(-1) === gaveUp
  );
}

// ---------- the identical-setter gate and the satisfied-setter drop ----------
{
  // The consumer re-queues its target right after the ACK (its effect re-runs on the old readback)
  const requeueAt = seconds(100) + SETTER_DURATION_MS + 500;
  const committing = simulateWrite(bootedState(), seconds(100), seconds(130), seconds(108), requeueAt);
  check(
    "committed: the identical re-queue is withdrawn once the confirm shows it — never sent again",
    actionStarts(committing.actions, "send_setter").length === 1 &&
      actionStarts(committing.actions, "drop_setter").length === 1 &&
      committing.state.queuedSetters.length === 0
  );
  const stuck = simulateWrite(bootedState(), seconds(100), seconds(170), undefined, requeueAt);
  const sends = actionStarts(stuck.actions, "send_setter");
  const gaveUp = stuck.confirms.find(confirm => confirm.result.gaveUpChecks.length);
  const gateOpensAt = seconds(100) + SETTER_DURATION_MS + IDENTICAL_SETTER_MIN_INTERVAL_MS;
  check(
    "stuck: the give-up comes first, the identical rewrite only when its 60 s gate opens",
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
  let state = withSettingsReadback(bootedState(), "GPMP", { maximum_feeding_grid_power: OLD_WATTS }, seconds(1));
  state = afterSetterSent(state, NEW_TARGET, ["GPMP"], seconds(2), true);
  state = withSettingsReadback(state, "GPMP", { maximum_feeding_grid_power: OLD_WATTS }, seconds(4));
  check(
    "a background readback during the phase doesn't satisfy the old target while the confirm is pending",
    !readbackAlreadySatisfies(state, "GPMP000350")
  );
  check("…nor the new one, though it is decoded after the write", !readbackAlreadySatisfies(state, NEW_TARGET));
  state = withSettingsReadback(state, "GPMP", { maximum_feeding_grid_power: NEW_WATTS }, seconds(11));
  state = afterConfirmRun(state, { GPMP: { maximum_feeding_grid_power: NEW_WATTS } }, seconds(11)).state;
  check("once confirmed, the readback vouches for the new target", readbackAlreadySatisfies(state, NEW_TARGET));
}

// ---------- a burst — each check gives up at its own deadline, the cadence keeps going ----------
{
  let state = bootedState();
  state = afterSetterSent(state, "EDF1", ["HECS"], seconds(0), true);
  state = afterSetterSent(state, "EDG1", ["HECS"], seconds(5), true);
  check(
    "a second write keeps the first one's confirm slot (no pushing it out)",
    state.confirm?.dueAt === FIRST_CONFIRM_AFTER_WRITE_MS,
    `due ${state.confirm?.dueAt}`
  );
  const neitherApplied = {
    HECS: {
      battery_discharge_to_feed_grid_when_solar_input_normal: "disabled",
      battery_discharge_to_feed_grid_when_solar_input_loss: "disabled",
    },
  };
  const firstRun = afterConfirmRun(state, neitherApplied, seconds(9));
  check(
    "the 9 s run judges EDF1 only — EDG1 (written at 5 s) is not judged before its own 9 s",
    firstRun.result.notYetJudgedChecks.map(youngCheck => youngCheck.forCommand).join() === "EDG1" &&
      firstRun.result.retry?.pendingChecks.length === 2 &&
      firstRun.result.retry.retryAt === seconds(13),
    JSON.stringify(firstRun.result.retry?.retryAt)
  );
  state = firstRun.state;
  for (let confirmAtSeconds = 13; confirmAtSeconds < 55; confirmAtSeconds += 4) {
    state = afterConfirmRun(state, neitherApplied, seconds(confirmAtSeconds)).state;
  }
  const atFirstDeadline = afterConfirmRun(state, neitherApplied, seconds(55));
  check(
    "EDF1 gives up at its own 55 s deadline while EDG1 (written 5 s later) is still re-checked",
    atFirstDeadline.result.gaveUpChecks.map(gaveUpCheck => gaveUpCheck.forCommand).join() === "EDF1" &&
      atFirstDeadline.result.retry?.pendingChecks.map(pendingCheck => pendingCheck.forCommand).join() === "EDG1" &&
      atFirstDeadline.result.retry.retryAt === seconds(59),
    JSON.stringify(atFirstDeadline.result.retry?.retryAt)
  );
}

// ---------- re-checks narrow to the pending checks' queries ----------
{
  const bothQueries = { GPMP: { maximum_feeding_grid_power: NEW_WATTS }, BATS: { "max._ac_charging_current": 6 } };
  const twoWrites = afterSetterSent(
    afterSetterSent(bootedState(), NEW_TARGET, ["GPMP"], seconds(0), true),
    "MUCHGC0100",
    ["BATS"],
    seconds(1),
    true
  );
  const afterFirstRun = afterConfirmRun(twoWrites, bothQueries, seconds(10)).state;
  check(
    "GPMP confirmed, MUCHGC still old → the re-check queries BATS only",
    afterFirstRun.confirm?.queries.join() === "BATS",
    JSON.stringify(afterFirstRun.confirm?.queries)
  );
}

console.log(
  `\n${fails.length ? `${fails.length} FAILED: ${fails.join(", ")}` : "all confirmCadence selftests passed"}`
);
process.exit(fails.length ? 1 : 0);

/** A scheduler that has finished its boot round (with the settings poll), so only GS+PS rounds follow */
function bootedState(): SchedulerState {
  return bootedScheduler({}, { GPMP: { maximum_feeding_grid_power: OLD_WATTS } });
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
