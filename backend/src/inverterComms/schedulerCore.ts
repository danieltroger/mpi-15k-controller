/**
 * The inverter session's scheduling brain — pure state + transition functions (no I/O, no timers)
 * so the write→quiet-gap→confirm→converged/backoff lifecycle is directly selftestable. The async
 * shell in inverterSession.ts just executes the decisions.
 *
 * Priority order baked into decideNextAction: control writes > confirm queries > background polls.
 */
import type { SettingsQueryCommandName } from "./pi17Protocol.types.ts";
import type { DecodedFields } from "./pi17Protocol.types.ts";
import { expectedReadbackChecksForSetter, checkIsSatisfied, type SetterReadbackCheck } from "./setterConfirmation.ts";

/**
 * Live-measured on the real MPI 15K (2026-07-18): the inverter ACKs a setter at frame level
 * immediately but APPLIES it on an internal housekeeping cycle — ~6 s after the write under light
 * traffic, and starved indefinitely under continuous traffic (67 ACKed identical MCHGV writes over
 * 5m48s at ~1 command/1.2 s never became visible to BATS; the commit finally landed 42 s into the
 * first quiet period). Hence: full radio silence for QUIET_GAP_AFTER_WRITE_MS after every setter
 * before the targeted confirm query runs…
 */
export const QUIET_GAP_AFTER_WRITE_MS = 12_000;
/** …a longer silent backoff if the readback still shows the old value… */
export const CONFIRM_BACKOFF_MS = 30_000;
/**
 * …and a hard gate so no consumer loop can hammer the same write into permanent starvation:
 * an identical setter string is never sent more often than this.
 */
export const IDENTICAL_SETTER_MIN_INTERVAL_MS = 60_000;
/** One confirm after the quiet gap + one re-check after the backoff, then give up loudly */
export const MAX_CONFIRM_ATTEMPTS = 2;
/**
 * Start-to-start pacing of the background GS+PS poll. At 2400 baud a GS+PS round is ≈1.5-2 s of
 * wire time anyway, so this is the natural continuous rate rather than a real throttle.
 */
export const POLL_ROUND_INTERVAL_MS = 2_000;

export type QueuedSetterView = {
  command: string;
  /** Earliest allowed send time — now at enqueue, pushed out by the identical-setter gate */
  notBefore: number;
};

export type ConfirmPhase = {
  /** No traffic at all until this time (the quiet gap / backoff the commit needs) */
  dueAt: number;
  attemptsMade: number;
  queries: readonly SettingsQueryCommandName[];
  checks: readonly SetterReadbackCheck[];
};

export type SchedulerState = {
  queuedSetters: readonly QueuedSetterView[];
  confirm: ConfirmPhase | undefined;
  lastSentAtByCommand: Readonly<Record<string, number>>;
  lastPollRoundStartedAt: number | undefined;
  lastSettingsPollAt: number | undefined;
};

export type SchedulerDecision =
  | { action: "send_setter"; command: string }
  | { action: "run_confirms"; queries: readonly SettingsQueryCommandName[] }
  | { action: "poll_round"; includeSettingsPoll: boolean }
  | { action: "wait"; untilMs: number; reason: string };

export function initialSchedulerState(): SchedulerState {
  return {
    queuedSetters: [],
    confirm: undefined,
    lastSentAtByCommand: {},
    lastPollRoundStartedAt: undefined,
    lastSettingsPollAt: undefined,
  };
}

export function decideNextAction(
  state: SchedulerState,
  nowMs: number,
  settingsPollIntervalMs: number
): SchedulerDecision {
  const eligibleSetter = state.queuedSetters.find(setter => setter.notBefore <= nowMs);
  if (eligibleSetter) return { action: "send_setter", command: eligibleSetter.command };
  // A gated setter must still wake the pump when its gate opens, whatever else we wait on
  const earliestSetterGate = state.queuedSetters.length
    ? Math.min(...state.queuedSetters.map(setter => setter.notBefore))
    : Infinity;

  if (state.confirm) {
    if (nowMs >= state.confirm.dueAt) return { action: "run_confirms", queries: state.confirm.queries };
    return {
      action: "wait",
      untilMs: Math.min(state.confirm.dueAt, earliestSetterGate),
      reason: state.confirm.attemptsMade === 0 ? "quiet gap after write" : "confirm backoff",
    };
  }

  const nextPollDueAt = (state.lastPollRoundStartedAt ?? 0) + POLL_ROUND_INTERVAL_MS;
  if (nowMs >= nextPollDueAt) {
    const includeSettingsPoll =
      state.lastSettingsPollAt === undefined || nowMs - state.lastSettingsPollAt >= settingsPollIntervalMs;
    return { action: "poll_round", includeSettingsPoll };
  }
  return { action: "wait", untilMs: Math.min(nextPollDueAt, earliestSetterGate), reason: "poll pacing" };
}

/** Enqueue a control write, replacing any queued same-prefix one (a stale target must never land after a newer one). */
export function withSetterQueued(
  state: SchedulerState,
  command: string,
  replacesPrefix: string,
  nowMs: number
): SchedulerState {
  const lastSentAt = state.lastSentAtByCommand[command];
  const notBefore = lastSentAt === undefined ? nowMs : Math.max(nowMs, lastSentAt + IDENTICAL_SETTER_MIN_INTERVAL_MS);
  return {
    ...state,
    queuedSetters: [
      ...state.queuedSetters.filter(setter => !setter.command.startsWith(replacesPrefix)),
      { command, notBefore },
    ],
  };
}

/** Remove the setter that is about to go on the wire (before the send, so a mid-flight replacement just re-queues). */
export function withSetterDequeued(state: SchedulerState, command: string): SchedulerState {
  const index = state.queuedSetters.findIndex(setter => setter.command === command);
  if (index === -1) return state;
  return { ...state, queuedSetters: state.queuedSetters.toSpliced(index, 1) };
}

/**
 * Record a completed setter transmission: start (or re-arm) the quiet gap and register the
 * readback checks. `expectApplied: false` (NAK / no response) still schedules the quiet gap and
 * refresh queries — a rejected write was traffic too, and the readback re-syncs the settings
 * stores — but skips the convergence checks so a NAK isn't double-reported as "never applied".
 */
export function afterSetterSent(
  state: SchedulerState,
  command: string,
  refreshQueries: readonly SettingsQueryCommandName[],
  nowMs: number,
  expectApplied: boolean
): SchedulerState {
  const newChecks = expectApplied ? expectedReadbackChecksForSetter(command) : [];
  // A superseding write to the same field replaces the old expectation (e.g. MCHGV0570… then MCHGV0580…)
  const retainedChecks = (state.confirm?.checks ?? []).filter(
    existing => !newChecks.some(added => added.query === existing.query && added.field === existing.field)
  );
  const checks = [...retainedChecks, ...newChecks];
  const queries = [
    ...new Set<SettingsQueryCommandName>([
      ...(state.confirm?.queries ?? []),
      ...refreshQueries,
      ...checks.map(check => check.query),
    ]),
  ];
  return {
    ...state,
    lastSentAtByCommand: { ...state.lastSentAtByCommand, [command]: nowMs },
    confirm: { dueAt: nowMs + QUIET_GAP_AFTER_WRITE_MS, attemptsMade: 0, queries, checks },
  };
}

export type ConfirmOutcome =
  | { outcome: "converged"; confirmedChecks: readonly SetterReadbackCheck[] }
  | { outcome: "retry"; retryAt: number; failedChecks: readonly SetterReadbackCheck[] }
  | { outcome: "gave_up"; failedChecks: readonly SetterReadbackCheck[] };

export function afterConfirmRun(
  state: SchedulerState,
  decodedByQuery: Partial<Record<SettingsQueryCommandName, DecodedFields>>,
  nowMs: number
): { state: SchedulerState; result: ConfirmOutcome } {
  const confirm = state.confirm;
  if (!confirm) {
    // Can't happen (only called after a run_confirms decision) — but if it does, don't invent state
    return { state, result: { outcome: "converged", confirmedChecks: [] } };
  }
  const failedChecks = confirm.checks.filter(check => !checkIsSatisfied(check, decodedByQuery));
  if (failedChecks.length === 0) {
    return {
      state: { ...state, confirm: undefined },
      result: { outcome: "converged", confirmedChecks: confirm.checks },
    };
  }
  const attemptsMade = confirm.attemptsMade + 1;
  if (attemptsMade >= MAX_CONFIRM_ATTEMPTS) {
    return { state: { ...state, confirm: undefined }, result: { outcome: "gave_up", failedChecks } };
  }
  const retryAt = nowMs + CONFIRM_BACKOFF_MS;
  return {
    state: { ...state, confirm: { ...confirm, attemptsMade, dueAt: retryAt } },
    result: { outcome: "retry", retryAt, failedChecks },
  };
}

export function afterPollRound(
  state: SchedulerState,
  roundStartedAtMs: number,
  includedSettingsPoll: boolean
): SchedulerState {
  return {
    ...state,
    lastPollRoundStartedAt: roundStartedAtMs,
    lastSettingsPollAt: includedSettingsPoll ? roundStartedAtMs : state.lastSettingsPollAt,
  };
}

export function hasEligibleSetter(state: SchedulerState, nowMs: number): boolean {
  return state.queuedSetters.some(setter => setter.notBefore <= nowMs);
}
