/**
 * The inverter session's scheduling brain — pure state + transition functions (no I/O, no timers)
 * so the write→quiet-gap→confirm→converged/backoff lifecycle is directly selftestable. The async
 * shell in inverterSession.ts just executes the decisions.
 *
 * Priority order baked into decideNextAction: dropping already-satisfied setters > control writes
 * > confirm queries > background polls.
 *
 * Every time here is the session's MONOTONIC clock (performance.now() ms), never wall time: an NTP
 * step (the unit starts before time sync) must neither cut a quiet gap short nor stretch one.
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
 * Gap between the END of one background GS+PS round and the start of the next: rounds run
 * back-to-back. At 2400 baud the two responses (~117 + ~112 B) are ≈1 s of wire time, so a round
 * takes ≈1.1 s — the cadence the retired mpp-solar daemon achieved (~51 rounds/min, measured in
 * Influx before the first cutover). A fixed 2 s start-to-start pace would have cut the point rate
 * by ~40%.
 */
export const POLL_ROUND_GAP_MS = 50;
/** …but after a round with a failed query, breathe before hammering a line that isn't answering */
export const POLL_ROUND_GAP_AFTER_FAILURE_MS = 1_000;

export type SchedulerTiming = {
  /**
   * QUIET-GAP EXPERIMENT HOOK. Production always runs QUIET_GAP_AFTER_WRITE_MS (pass no override).
   * Still open: does the inverter's ACK≠commit delay come from ANY serial traffic or only from
   * rewriting the same register? The planned experiment (gap 0, GS/PS polling continuing, one
   * benign GPMP write, 1 Hz readback) overrides this — and will additionally need confirm-phase
   * polling, which this state machine deliberately doesn't do today.
   */
  quietGapAfterWriteMs: number;
  confirmBackoffMs: number;
  pollRoundGapMs: number;
  pollRoundGapAfterFailureMs: number;
};

export const DEFAULT_SCHEDULER_TIMING: Readonly<SchedulerTiming> = {
  quietGapAfterWriteMs: QUIET_GAP_AFTER_WRITE_MS,
  confirmBackoffMs: CONFIRM_BACKOFF_MS,
  pollRoundGapMs: POLL_ROUND_GAP_MS,
  pollRoundGapAfterFailureMs: POLL_ROUND_GAP_AFTER_FAILURE_MS,
};

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

/** The newest decoded settings readback per query, and when it was decoded */
export type SettingsReadback = { fields: DecodedFields; decodedAtMs: number };

export type SchedulerState = {
  timing: Readonly<SchedulerTiming>;
  queuedSetters: readonly QueuedSetterView[];
  confirm: ConfirmPhase | undefined;
  lastSentAtByCommand: Readonly<Record<string, number>>;
  /**
   * When each readback field was last written, keyed by readbackFieldKey(query, field) — a readback
   * is trusted per field (each EDx sets one HECS flag; another flag's write says nothing about it)
   */
  lastWriteAtByReadbackField: Readonly<Record<string, number>>;
  lastPollRoundEndedAt: number | undefined;
  lastPollRoundHadFailures: boolean;
  /** Start of the last round that included the settings queries */
  lastSettingsPollAt: number | undefined;
  latestSettingsReadbacks: Readonly<Partial<Record<SettingsQueryCommandName, SettingsReadback>>>;
};

export type SchedulerDecision =
  /** The latest trustworthy readback already shows this setter's target — sending it is pointless at best */
  | { action: "drop_setter"; command: string }
  | { action: "send_setter"; command: string }
  | { action: "run_confirms"; queries: readonly SettingsQueryCommandName[] }
  | { action: "poll_round"; includeSettingsPoll: boolean }
  | { action: "wait"; untilMs: number; reason: string };

/** `timingOverrides` exists for harnesses and the quiet-gap experiment — production passes none. */
export function initialSchedulerState(timingOverrides: Partial<SchedulerTiming> = {}): SchedulerState {
  return {
    timing: { ...DEFAULT_SCHEDULER_TIMING, ...timingOverrides },
    queuedSetters: [],
    confirm: undefined,
    lastSentAtByCommand: {},
    lastWriteAtByReadbackField: {},
    lastPollRoundEndedAt: undefined,
    lastPollRoundHadFailures: false,
    lastSettingsPollAt: undefined,
    latestSettingsReadbacks: {},
  };
}

export function decideNextAction(
  state: SchedulerState,
  nowMs: number,
  settingsPollIntervalMs: number
): SchedulerDecision {
  // Consumers queue their desired state; one the inverter already holds is withdrawn, gated or not.
  // That is what keeps an abandoned target (queued, then the consumer's wish moved back to what the
  // readback shows) from landing when its identical-setter gate opens.
  const satisfiedSetter = state.queuedSetters.find(setter => readbackAlreadySatisfies(state, setter.command));
  if (satisfiedSetter) return { action: "drop_setter", command: satisfiedSetter.command };
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

  const gapAfterLastRound = state.lastPollRoundHadFailures
    ? state.timing.pollRoundGapAfterFailureMs
    : state.timing.pollRoundGapMs;
  const nextPollDueAt = state.lastPollRoundEndedAt === undefined ? 0 : state.lastPollRoundEndedAt + gapAfterLastRound;
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
  const fieldsThisCommandWrites = expectedReadbackChecksForSetter(command);
  const newChecks = expectApplied ? fieldsThisCommandWrites : [];
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
  // Every send may have changed its fields — ACKed, NAKed or unanswered alike (a NAK'd or lost
  // write can still have committed), so readbacks older than this can't vouch for them any more
  const lastWriteAtByReadbackField = { ...state.lastWriteAtByReadbackField };
  for (const check of fieldsThisCommandWrites) {
    lastWriteAtByReadbackField[readbackFieldKey(check.query, check.field)] = nowMs;
  }
  return {
    ...state,
    lastSentAtByCommand: { ...state.lastSentAtByCommand, [command]: nowMs },
    lastWriteAtByReadbackField,
    // A copy queued while this one was on the wire got its gate from the PREVIOUS send; re-gate it
    // from this one, or it would go out straight after the ACK — a back-to-back duplicate write
    queuedSetters: state.queuedSetters.map(setter =>
      setter.command === command
        ? { ...setter, notBefore: Math.max(setter.notBefore, nowMs + IDENTICAL_SETTER_MIN_INTERVAL_MS) }
        : setter
    ),
    confirm: { dueAt: nowMs + state.timing.quietGapAfterWriteMs, attemptsMade: 0, queries, checks },
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
  const retryAt = nowMs + state.timing.confirmBackoffMs;
  return {
    state: { ...state, confirm: { ...confirm, attemptsMade, dueAt: retryAt } },
    result: { outcome: "retry", retryAt, failedChecks },
  };
}

export function afterPollRound(
  state: SchedulerState,
  round: { startedAtMs: number; endedAtMs: number; includedSettingsPoll: boolean; hadFailures: boolean }
): SchedulerState {
  return {
    ...state,
    lastPollRoundEndedAt: round.endedAtMs,
    lastPollRoundHadFailures: round.hadFailures,
    lastSettingsPollAt: round.includedSettingsPoll ? round.startedAtMs : state.lastSettingsPollAt,
  };
}

/** Record a decoded GPMP/HECS/BATS answer (background poll or confirm) as the newest readback for that query. */
export function withSettingsReadback(
  state: SchedulerState,
  query: SettingsQueryCommandName,
  fields: DecodedFields,
  nowMs: number
): SchedulerState {
  return {
    ...state,
    latestSettingsReadbacks: { ...state.latestSettingsReadbacks, [query]: { fields, decodedAtMs: nowMs } },
  };
}

/**
 * Does the latest readback prove the inverter already holds this setter's target? Only a readback
 * that can stand in for the inverter's state counts, field by field: decoded after the last write to
 * that field, and with no pending confirm on it (an ACKed write may still commit and change it). A
 * setter with no readback mapping is never considered satisfied.
 */
export function readbackAlreadySatisfies(state: SchedulerState, command: string): boolean {
  const checks = expectedReadbackChecksForSetter(command);
  if (!checks.length) return false;
  return checks.every(check => {
    const readback = state.latestSettingsReadbacks[check.query];
    const lastWriteToField = state.lastWriteAtByReadbackField[readbackFieldKey(check.query, check.field)] ?? -Infinity;
    if (!readback || readback.decodedAtMs <= lastWriteToField) return false;
    const confirmStillPending = state.confirm?.checks.some(
      pending => pending.query === check.query && pending.field === check.field
    );
    return !confirmStillPending && checkIsSatisfied(check, { [check.query]: readback.fields });
  });
}

function readbackFieldKey(query: SettingsQueryCommandName, field: string): string {
  return `${query}:${field}`;
}

/**
 * Should a running poll round yield to a control write? Not for a setter the readback already
 * satisfies: consumers queue desired state on every change, and those must not chop rounds short.
 */
export function hasEligibleSetter(state: SchedulerState, nowMs: number): boolean {
  return state.queuedSetters.some(
    setter => setter.notBefore <= nowMs && !readbackAlreadySatisfies(state, setter.command)
  );
}
