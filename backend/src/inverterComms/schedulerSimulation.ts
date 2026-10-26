/**
 * Test helper for the scheduler selftests (not a selftest itself): runs schedulerCore through a
 * simulated pump against fake settings registers whose writes commit when the scenario says, with
 * scenario events (queued setters, knob changes) applied at their times. Actions take their
 * 2400-baud wire time; setters are ACKed at once. Pure, no timers. Grown from the review harness of
 * PR #62, whose scenarios run through it in confirmPhaseScenarios.selftest.ts.
 */
import type { DecodedFields, SettingsQueryCommandName } from "./pi17Protocol.types.ts";
import {
  afterConfirmRun,
  afterPollRound,
  afterSetterSent,
  decideNextAction,
  initialSchedulerState,
  withQuietGapAfterWrite,
  withSettingsReadback,
  withSetterDequeued,
  withSetterQueued,
  type ConfirmOutcome,
  type ConfirmPhase,
  type SchedulerState,
} from "./schedulerCore.ts";
import type { SchedulerTiming } from "./schedulerTiming.ts";
import { expectedReadbackChecksForSetter } from "./setterConfirmation.ts";

/** GS+PS ≈ 1.1 s of wire time (2.5 s with the settings queries); a settings answer ~0.15 s; a setter and its ACK ~0.1 s */
export const POLL_ROUND_DURATION_MS = 1_100;
export const SETTINGS_POLL_ROUND_DURATION_MS = 2_500;
export const CONFIRM_QUERY_DURATION_MS = 150;
export const SETTER_DURATION_MS = 100;
export const SETTINGS_POLL_INTERVAL_MS = 300_000;
/** Every scenario boots with a full round (settings included) ending here, then starts at 100 s */
const BOOT_ROUND_ENDS_AT_MS = 99_000;

export type SimulatedRegister = {
  query: SettingsQueryCommandName;
  field: string;
  /** What the register reads until its first commit lands */
  initialValue: number | string;
  /** Values landing at a given time — added by the scenario's onSetterSent as writes go out */
  commits: { atMs: number; value: number | string }[];
};

export type ScenarioEvent = { atMs: number; apply: (state: SchedulerState, nowMs: number) => SchedulerState };

export type SimulatedStep =
  | { action: "poll_round"; startedAtMs: number; endedAtMs: number }
  | { action: "drop_setter"; command: string; startedAtMs: number; endedAtMs: number }
  | {
      action: "send_setter";
      command: string;
      startedAtMs: number;
      endedAtMs: number;
      /** The confirm phase the send armed (or merged into) */
      armed: ConfirmPhase | undefined;
    }
  | {
      action: "run_confirms";
      queries: readonly SettingsQueryCommandName[];
      startedAtMs: number;
      endedAtMs: number;
      result: ConfirmOutcome;
      /** The scheduler right after the run */
      stateAfter: SchedulerState;
    };

export type SimulatedConfirmRun = Extract<SimulatedStep, { action: "run_confirms" }>;
export type SimulatedSend = Extract<SimulatedStep, { action: "send_setter" }>;

export function simulatePump({
  initial,
  registers,
  events,
  fromMs,
  untilMs,
  onSetterSent = () => {},
  settingsPollIntervalMs = SETTINGS_POLL_INTERVAL_MS,
}: {
  initial: SchedulerState;
  registers: SimulatedRegister[];
  events: readonly ScenarioEvent[];
  fromMs: number;
  untilMs: number;
  /** Called with each setter's ACK time, e.g. to schedule its commit */
  onSetterSent?: (command: string, sentAtMs: number) => void;
  /** The slow settings poll's cadence; its rounds read every register, like the session's */
  settingsPollIntervalMs?: number;
}): { state: SchedulerState; steps: SimulatedStep[] } {
  let state = initial;
  let nowMs = fromMs;
  const pendingEvents = [...events].sort((first, second) => first.atMs - second.atMs);
  const steps: SimulatedStep[] = [];
  while (nowMs < untilMs) {
    while (pendingEvents.length && pendingEvents[0]!.atMs <= nowMs) state = pendingEvents.shift()!.apply(state, nowMs);
    const decision = decideNextAction(state, nowMs, settingsPollIntervalMs);
    const startedAtMs = nowMs;
    if (decision.action === "wait") {
      const wakeAt = Math.min(decision.untilMs, pendingEvents[0]?.atMs ?? Infinity);
      nowMs = Math.min(Math.max(wakeAt, nowMs + 1), untilMs);
    } else if (decision.action === "drop_setter") {
      state = withSetterDequeued(state, decision.command);
      steps.push({ action: "drop_setter", command: decision.command, startedAtMs, endedAtMs: nowMs });
    } else if (decision.action === "send_setter") {
      nowMs += SETTER_DURATION_MS;
      state = afterSetterSent(withSetterDequeued(state, decision.command), decision.command, [], nowMs, true);
      onSetterSent(decision.command, nowMs);
      steps.push({
        action: "send_setter",
        command: decision.command,
        startedAtMs,
        endedAtMs: nowMs,
        armed: state.confirm,
      });
    } else if (decision.action === "run_confirms") {
      nowMs += CONFIRM_QUERY_DURATION_MS * decision.queries.length;
      const decodedByQuery = readRegisters(registers, decision.queries, nowMs);
      for (const query of decision.queries)
        state = withSettingsReadback(state, query, decodedByQuery[query] ?? {}, nowMs);
      const confirmRun = afterConfirmRun(state, decodedByQuery, nowMs);
      state = confirmRun.state;
      steps.push({
        action: "run_confirms",
        queries: decision.queries,
        startedAtMs,
        endedAtMs: nowMs,
        result: confirmRun.result,
        stateAfter: state,
      });
    } else {
      nowMs += decision.includeSettingsPoll ? SETTINGS_POLL_ROUND_DURATION_MS : POLL_ROUND_DURATION_MS;
      if (decision.includeSettingsPoll) {
        const settingsQueries = [...new Set(registers.map(register => register.query))];
        const decodedByQuery = readRegisters(registers, settingsQueries, nowMs);
        for (const query of settingsQueries) {
          state = withSettingsReadback(state, query, decodedByQuery[query] ?? {}, nowMs);
        }
      }
      state = afterPollRound(state, {
        startedAtMs,
        endedAtMs: nowMs,
        includedSettingsPoll: decision.includeSettingsPoll,
        hadFailures: false,
      });
      steps.push({ action: "poll_round", startedAtMs, endedAtMs: nowMs });
    }
  }
  return { state, steps };
}

/** One register per field of the boot readbacks, reading its boot value until a commit lands */
export function registersFor(
  bootReadbacks: Partial<Record<SettingsQueryCommandName, DecodedFields>>
): SimulatedRegister[] {
  return Object.entries(bootReadbacks).flatMap(([query, fields]) =>
    Object.entries(fields ?? {}).map(([field, initialValue]) => ({
      query: query as SettingsQueryCommandName,
      field,
      initialValue,
      commits: [],
    }))
  );
}

/** A scheduler that has finished its boot round (with the settings poll) and holds those readbacks */
export function bootedScheduler(
  timing: Partial<SchedulerTiming>,
  bootReadbacks: Partial<Record<SettingsQueryCommandName, DecodedFields>>
): SchedulerState {
  let state = afterPollRound(initialSchedulerState(timing), {
    startedAtMs: BOOT_ROUND_ENDS_AT_MS - 1_000,
    endedAtMs: BOOT_ROUND_ENDS_AT_MS,
    includedSettingsPoll: true,
    hadFailures: false,
  });
  for (const [query, fields] of Object.entries(bootReadbacks)) {
    state = withSettingsReadback(state, query as SettingsQueryCommandName, fields ?? {}, BOOT_ROUND_ENDS_AT_MS);
  }
  return state;
}

/**
 * onSetterSent for "every write commits `delayMs` after it goes out, except `neverCommits`" — the
 * commit lands the setter's own readback values (expectedReadbackChecksForSetter) in its registers
 */
export function commitsLandAfter(
  registers: SimulatedRegister[],
  delayMs: number,
  neverCommits: readonly string[] = []
): (command: string, sentAtMs: number) => void {
  return (command, sentAtMs) => {
    if (neverCommits.includes(command)) return;
    for (const check of expectedReadbackChecksForSetter(command)) {
      const register = registers.find(candidate => candidate.query === check.query && candidate.field === check.field);
      if (!register) throw new Error(`scenario has no register for ${check.query} ${check.field}`);
      register.commits.push({ atMs: sentAtMs + delayMs, value: check.expectedValue });
      register.commits.sort((first, second) => first.atMs - second.atMs);
    }
  };
}

export function queueSetterAt(atMs: number, command: string, replacesPrefix: string): ScenarioEvent {
  return { atMs, apply: (state, nowMs) => withSetterQueued(state, command, replacesPrefix, nowMs) };
}

export function knobChangeAt(atMs: number, quietGapAfterWriteMs: number): ScenarioEvent {
  return { atMs, apply: state => withQuietGapAfterWrite(state, quietGapAfterWriteMs) };
}

export function readRegisters(
  registers: readonly SimulatedRegister[],
  queries: readonly SettingsQueryCommandName[],
  nowMs: number
): Partial<Record<SettingsQueryCommandName, DecodedFields>> {
  const decodedByQuery: Partial<Record<SettingsQueryCommandName, DecodedFields>> = {};
  for (const register of registers.filter(candidate => queries.includes(candidate.query))) {
    const landed = register.commits.filter(commit => commit.atMs <= nowMs).at(-1);
    decodedByQuery[register.query] = {
      ...decodedByQuery[register.query],
      [register.field]: landed ? landed.value : register.initialValue,
    };
  }
  return decodedByQuery;
}

export function confirmRunsIn(steps: readonly SimulatedStep[]): SimulatedConfirmRun[] {
  return steps.filter((step): step is SimulatedConfirmRun => step.action === "run_confirms");
}

export function sendsIn(steps: readonly SimulatedStep[], command?: string): SimulatedSend[] {
  return steps.filter(
    (step): step is SimulatedSend =>
      step.action === "send_setter" && (command === undefined || step.command === command)
  );
}

export function startTimesOf(steps: readonly SimulatedStep[], action: SimulatedStep["action"]): number[] {
  return steps.filter(step => step.action === action).map(step => step.startedAtMs);
}

/** The first confirm run whose outcome puts `command` in the given verdict list */
export function firstRunWith(
  steps: readonly SimulatedStep[],
  verdict: "confirmedChecks" | "gaveUpChecks" | "notYetJudgedChecks",
  command: string
): SimulatedConfirmRun | undefined {
  return confirmRunsIn(steps).find(run => run.result[verdict].some(check => check.forCommand === command));
}
