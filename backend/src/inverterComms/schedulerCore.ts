/**
 * The inverter session's scheduling brain — pure state + transition functions (no I/O, no timers)
 * so the write→confirm→converged/re-check/give-up lifecycle is directly selftestable. The async
 * shell in inverterSession.ts just executes the decisions; the numbers live in schedulerTiming.ts.
 *
 * Priority order baked into decideNextAction: dropping already-satisfied setters > control writes
 * > confirm queries > background polls. Polling never pauses for a confirm: the confirm readbacks
 * slot in between poll rounds when they are due.
 *
 * Every time here is the session's MONOTONIC clock (performance.now() ms), never wall time: an NTP
 * step (the unit starts before time sync) must neither bring a confirm forward nor push one out.
 */
import type { SettingsQueryCommandName } from "./pi17Protocol.types.ts";
import type { DecodedFields } from "./pi17Protocol.types.ts";
import { expectedReadbackChecksForSetter, checkIsSatisfied, type SetterReadbackCheck } from "./setterConfirmation.ts";
import {
  DEFAULT_SCHEDULER_TIMING,
  IDENTICAL_SETTER_MIN_INTERVAL_MS,
  SETTINGS_READBACK_REQUEST_LIFETIME_MS,
  type SchedulerTiming,
} from "./schedulerTiming.ts";
import { judgeConfirmRun, type ConfirmVerdicts } from "./confirmVerdicts.ts";
import {
  chainMayLeave,
  chainsAfterReadback,
  chainsWithWrite,
  readbackFieldKey,
  type FieldWriteChains,
} from "./fieldWriteChains.ts";
import {
  settingsReadbackRequested,
  type SettingsReadbackRequests,
  withReadbackAnswered,
  withReadbackRequested,
} from "./settingsReadbackRequests.ts";

export type QueuedSetterView = {
  command: string;
  /** Earliest allowed send time — now at enqueue, pushed out by the identical-setter gate */
  notBefore: number;
};

/** A readback check still waiting for its verdict, with the send it verifies */
export type PendingReadbackCheck = SetterReadbackCheck & { writtenAtMs: number };

export type ConfirmPhase = {
  /** When the next confirm run is due; polling continues until then */
  dueAt: number;
  queries: readonly SettingsQueryCommandName[];
  /** Only checks without a verdict yet: a confirmed or given-up check leaves the phase */
  checks: readonly PendingReadbackCheck[];
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
  /** Per field, the writes no readback has proven committed yet (fieldWriteChains.ts), for the confirm */
  fieldWriteChains: FieldWriteChains;
  /** The same writes credited with the longer drop-trust window: what the satisfied drop reads */
  dropTrustChains: FieldWriteChains;
  lastPollRoundEndedAt: number | undefined;
  lastPollRoundHadFailures: boolean;
  /** Start of the last round that included the settings queries */
  lastSettingsPollAt: number | undefined;
  latestSettingsReadbacks: Readonly<Partial<Record<SettingsQueryCommandName, SettingsReadback>>>;
  /** Readbacks consumers asked for, open until their query decodes (settingsReadbackRequests.ts) */
  settingsReadbackRequests: SettingsReadbackRequests;
};

export type SchedulerDecision =
  /** The latest trustworthy readback already shows this setter's target — sending it is pointless at best */
  | { action: "drop_setter"; command: string }
  | { action: "send_setter"; command: string }
  | { action: "run_confirms"; queries: readonly SettingsQueryCommandName[] }
  | { action: "poll_round"; includeSettingsPoll: boolean }
  | { action: "wait"; untilMs: number; reason: string };

/** Production runs the defaults; overrides are for harnesses only. */
export function initialSchedulerState(timingOverrides: Partial<SchedulerTiming> = {}): SchedulerState {
  return {
    timing: { ...DEFAULT_SCHEDULER_TIMING, ...timingOverrides },
    queuedSetters: [],
    confirm: undefined,
    lastSentAtByCommand: {},
    lastWriteAtByReadbackField: {},
    fieldWriteChains: {},
    dropTrustChains: {},
    lastPollRoundEndedAt: undefined,
    lastPollRoundHadFailures: false,
    lastSettingsPollAt: undefined,
    latestSettingsReadbacks: {},
    settingsReadbackRequests: {},
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

  if (state.confirm && nowMs >= state.confirm.dueAt) return { action: "run_confirms", queries: state.confirm.queries };
  // Background polling carries on until a confirm is due
  const nextConfirmDueAt = state.confirm?.dueAt ?? Infinity;

  const gapAfterLastRound = state.lastPollRoundHadFailures
    ? state.timing.pollRoundGapAfterFailureMs
    : state.timing.pollRoundGapMs;
  const nextPollDueAt = state.lastPollRoundEndedAt === undefined ? 0 : state.lastPollRoundEndedAt + gapAfterLastRound;
  if (nowMs >= nextPollDueAt) {
    const includeSettingsPoll =
      state.lastSettingsPollAt === undefined ||
      nowMs - state.lastSettingsPollAt >= settingsPollIntervalMs ||
      settingsReadbackRequested(state.settingsReadbackRequests, nowMs, SETTINGS_READBACK_REQUEST_LIFETIME_MS);
    return { action: "poll_round", includeSettingsPoll };
  }
  return {
    action: "wait",
    untilMs: Math.min(nextPollDueAt, earliestSetterGate, nextConfirmDueAt),
    reason: "poll pacing",
  };
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
 * Record a completed setter transmission: start (or join) the confirm phase and register the
 * readback checks. `expectApplied: false` (NAK / no response) still schedules the confirm and refresh
 * queries — a rejected or lost write can still have committed, and the readback re-syncs the settings
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
  const newChecks = expectApplied ? fieldsThisCommandWrites.map(check => ({ ...check, writtenAtMs: nowMs })) : [];
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
  let { fieldWriteChains, dropTrustChains } = state;
  for (const check of fieldsThisCommandWrites) {
    const fieldKey = readbackFieldKey(check.query, check.field);
    const write = { value: check.expectedValue, sentAtMs: nowMs };
    const latestReadbackValue = state.latestSettingsReadbacks[check.query]?.fields[check.field];
    lastWriteAtByReadbackField[fieldKey] = nowMs;
    fieldWriteChains = chainsWithWrite(fieldWriteChains, fieldKey, write, latestReadbackValue);
    dropTrustChains = chainsWithWrite(dropTrustChains, fieldKey, write, latestReadbackValue);
  }
  return {
    ...state,
    lastSentAtByCommand: { ...state.lastSentAtByCommand, [command]: nowMs },
    lastWriteAtByReadbackField,
    fieldWriteChains,
    dropTrustChains,
    // A copy queued while this one was on the wire got its gate from the PREVIOUS send; re-gate it
    // from this one, or it would go out straight after the ACK — a back-to-back duplicate write
    queuedSetters: state.queuedSetters.map(setter =>
      setter.command === command
        ? { ...setter, notBefore: Math.max(setter.notBefore, nowMs + IDENTICAL_SETTER_MIN_INTERVAL_MS) }
        : setter
    ),
    confirm: { dueAt: firstConfirmDueAt(state, nowMs), queries, checks },
  };
}

function firstConfirmDueAt(state: SchedulerState, writtenAtMs: number): number {
  const firstDueForThisWrite = writtenAtMs + state.timing.firstConfirmAfterWriteMs;
  // A running cadence keeps going, so a stream of writes to other fields can't keep pushing an
  // earlier write's confirm (and verdict) out
  return state.confirm ? Math.min(state.confirm.dueAt, firstDueForThisWrite) : firstDueForThisWrite;
}

/**
 * `nowMs` is when the run's last answer came in (deadlines and the next run count from it).
 * `runStartedAtMs` is when its first query went out: every readback of the run was decoded after
 * it, so the minimum-age rule (FIRST_CONFIRM_AFTER_WRITE_MS) is judged against it. It
 * defaults to `nowMs`, an instantaneous run (the pure tests); the session and the simulation pass the
 * real start.
 */
export function afterConfirmRun(
  state: SchedulerState,
  decodedByQuery: Partial<Record<SettingsQueryCommandName, DecodedFields>>,
  nowMs: number,
  runStartedAtMs: number = nowMs
): { state: SchedulerState; result: ConfirmVerdicts } {
  const confirm = state.confirm;
  if (!confirm) {
    // Can't happen (only called after a run_confirms decision) — but if it does, don't invent state
    return { state, result: { confirmedChecks: [], gaveUpChecks: [], notYetJudgedChecks: [], retry: undefined } };
  }
  const result = judgeConfirmRun(confirm, state.timing, decodedByQuery, state.fieldWriteChains, {
    runStartedAtMs,
    nowMs,
  });
  const retry = result.retry;
  if (!retry) return { state: { ...state, confirm: undefined }, result };
  // Re-checks run only what the pending checks need (the refresh queries ran on the first run) —
  // not BATS every 4 s for a GPMP write
  const queries = [...new Set(retry.pendingChecks.map(check => check.query))];
  return {
    state: { ...state, confirm: { dueAt: retry.retryAt, checks: retry.pendingChecks, queries } },
    result,
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

/** A consumer needs `query` read ahead of the interval: poll rounds include the settings until it decodes */
export function withSettingsReadbackRequested(
  state: SchedulerState,
  query: SettingsQueryCommandName,
  nowMs: number
): SchedulerState {
  return { ...state, settingsReadbackRequests: withReadbackRequested(state.settingsReadbackRequests, query, nowMs) };
}

/**
 * Record a decoded GPMP/HECS/BATS answer (background poll or confirm) as the newest readback for
 * that query, and credit it to the writes it proves landed (fieldWriteChains.ts).
 */
export function withSettingsReadback(
  state: SchedulerState,
  query: SettingsQueryCommandName,
  fields: DecodedFields,
  nowMs: number
): SchedulerState {
  const { writeCommitWindowMs, dropTrustCommitWindowMs } = state.timing;
  return {
    ...state,
    latestSettingsReadbacks: { ...state.latestSettingsReadbacks, [query]: { fields, decodedAtMs: nowMs } },
    settingsReadbackRequests: withReadbackAnswered(state.settingsReadbackRequests, query),
    fieldWriteChains: chainsAfterReadback(state.fieldWriteChains, query, fields, nowMs, writeCommitWindowMs),
    dropTrustChains: chainsAfterReadback(state.dropTrustChains, query, fields, nowMs, dropTrustCommitWindowMs),
  };
}

/**
 * Does the latest readback prove the inverter already holds this setter's target? Only a readback
 * that can stand in for the inverter's state counts, field by field: decoded after the last write to
 * that field, with no pending confirm on it (an ACKed write may still commit and change it), and no
 * unproven write of another value still able to land (after 10 A → 261 A, a 10 A readback can be
 * the first write landing before the second). "Unproven" here uses the drop-trust window, longer
 * than the confirm's: withholding a drop only costs a redundant write. A setter with no readback
 * mapping is never considered satisfied.
 */
export function readbackAlreadySatisfies(state: SchedulerState, command: string): boolean {
  const checks = expectedReadbackChecksForSetter(command);
  if (!checks.length) return false;
  return checks.every(check => {
    const readback = state.latestSettingsReadbacks[check.query];
    const fieldKey = readbackFieldKey(check.query, check.field);
    const lastWriteToField = state.lastWriteAtByReadbackField[fieldKey] ?? -Infinity;
    if (!readback || readback.decodedAtMs <= lastWriteToField) return false;
    if (chainMayLeave(state.dropTrustChains[fieldKey], check.expectedValue)) return false;
    const confirmStillPending = state.confirm?.checks.some(
      pending => pending.query === check.query && pending.field === check.field
    );
    return !confirmStillPending && checkIsSatisfied(check, { [check.query]: readback.fields });
  });
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
