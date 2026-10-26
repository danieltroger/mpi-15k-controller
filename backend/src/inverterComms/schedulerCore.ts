/**
 * The inverter session's scheduling brain — pure state + transition functions (no I/O, no timers)
 * so the write→quiet-gap→confirm→converged/backoff lifecycle is directly selftestable. The async
 * shell in inverterSession.ts just executes the decisions; the numbers live in schedulerTiming.ts.
 *
 * Priority order baked into decideNextAction: dropping already-satisfied setters > control writes
 * > confirm queries > background polls. Whether polls pause for a confirm phase depends on its
 * ConfirmStrategy: silent phases stop all traffic until each confirm, interleaved ones don't.
 *
 * Every time here is the session's MONOTONIC clock (performance.now() ms), never wall time: an NTP
 * step (the unit starts before time sync) must neither cut a quiet gap short nor stretch one.
 */
import type { SettingsQueryCommandName } from "./pi17Protocol.types.ts";
import type { DecodedFields } from "./pi17Protocol.types.ts";
import { expectedReadbackChecksForSetter, checkIsSatisfied, type SetterReadbackCheck } from "./setterConfirmation.ts";
import {
  confirmStrategyFor,
  DEFAULT_SCHEDULER_TIMING,
  IDENTICAL_SETTER_MIN_INTERVAL_MS,
  type ConfirmStrategy,
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

export type QueuedSetterView = {
  command: string;
  /** Earliest allowed send time — now at enqueue, pushed out by the identical-setter gate */
  notBefore: number;
};

/** A readback check still waiting for its verdict, with the send it verifies */
export type PendingReadbackCheck = SetterReadbackCheck & { writtenAtMs: number };

export type ConfirmPhase = {
  strategy: ConfirmStrategy;
  /**
   * The gap the phase was armed with (0 = interleaved). Writes merging into the phase keep it and
   * the strategy: a knob change mid-phase would otherwise cut a silent write's gap short, or move
   * an interleaved write off its own give-up onto a schedule its gated identical copy outruns.
   */
  quietGapAfterWriteMs: number;
  /** When the next confirm run is due — silent: no traffic at all before it; interleaved: polls continue */
  dueAt: number;
  attemptsMade: number;
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
  /**
   * An interleaved write gave up while the knob was 0: new phases use the silent fallback gap
   * (STARVATION_FALLBACK_QUIET_GAP_MS) until the knob next changes
   */
  starvationFallback: boolean;
};

export type SchedulerDecision =
  /** The latest trustworthy readback already shows this setter's target — sending it is pointless at best */
  | { action: "drop_setter"; command: string }
  | { action: "send_setter"; command: string }
  | { action: "run_confirms"; queries: readonly SettingsQueryCommandName[] }
  | { action: "poll_round"; includeSettingsPoll: boolean }
  | { action: "wait"; untilMs: number; reason: string };

/** The session passes the configured quiet gap; every other override is for harnesses only. */
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
    starvationFallback: false,
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
    if (state.confirm.strategy === "silent") {
      return {
        action: "wait",
        untilMs: Math.min(state.confirm.dueAt, earliestSetterGate),
        reason: state.confirm.attemptsMade === 0 ? "quiet gap after write" : "confirm backoff",
      };
    }
    // Interleaved: background polling carries on until the confirm is due
  }
  const nextConfirmDueAt = state.confirm?.dueAt ?? Infinity;

  const gapAfterLastRound = state.lastPollRoundHadFailures
    ? state.timing.pollRoundGapAfterFailureMs
    : state.timing.pollRoundGapMs;
  const nextPollDueAt = state.lastPollRoundEndedAt === undefined ? 0 : state.lastPollRoundEndedAt + gapAfterLastRound;
  if (nowMs >= nextPollDueAt) {
    const includeSettingsPoll =
      state.lastSettingsPollAt === undefined || nowMs - state.lastSettingsPollAt >= settingsPollIntervalMs;
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
 * Record a completed setter transmission: start (or re-arm) the confirm phase, with the strategy
 * the current quiet gap selects, and register the readback checks. `expectApplied: false` (NAK /
 * no response) still schedules the confirm and refresh queries — a rejected write was traffic too,
 * and the readback re-syncs the settings stores — but skips the convergence checks so a NAK isn't
 * double-reported as "never applied".
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
  const quietGapAfterWriteMs = state.confirm?.quietGapAfterWriteMs ?? quietGapForNewPhase(state);
  const strategy = confirmStrategyFor(quietGapAfterWriteMs);
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
    confirm: {
      strategy,
      quietGapAfterWriteMs,
      dueAt: firstConfirmDueAt(state, strategy, quietGapAfterWriteMs, nowMs),
      attemptsMade: 0,
      queries,
      checks,
    },
  };
}

function quietGapForNewPhase(state: SchedulerState): number {
  return state.starvationFallback ? state.timing.starvationFallbackQuietGapMs : state.timing.quietGapAfterWriteMs;
}

function firstConfirmDueAt(
  state: SchedulerState,
  strategy: ConfirmStrategy,
  quietGapAfterWriteMs: number,
  writtenAtMs: number
): number {
  // Silent: a burst re-arms the silence from its LAST write
  if (strategy === "silent") return writtenAtMs + quietGapAfterWriteMs;
  const firstDueForThisWrite = writtenAtMs + state.timing.firstInterleavedConfirmAfterWriteMs;
  // Interleaved: a running cadence keeps going, so a stream of writes to other fields can't keep
  // pushing an earlier write's confirm (and verdict) out
  return state.confirm?.strategy === "interleaved"
    ? Math.min(state.confirm.dueAt, firstDueForThisWrite)
    : firstDueForThisWrite;
}

/**
 * A live change of usb_parameter_setting.quiet_gap_after_write_ms (already through
 * effectiveQuietGapMs). Applies from the first write after any running phase, which keeps its gap
 * and strategy. Ends a starvation fallback: changing the knob is the operator's call.
 */
export function withQuietGapAfterWrite(state: SchedulerState, quietGapAfterWriteMs: number): SchedulerState {
  return { ...state, timing: { ...state.timing, quietGapAfterWriteMs }, starvationFallback: false };
}

/** What one confirm run decided, plus whether its give-up started the starvation fallback */
export type ConfirmOutcome = ConfirmVerdicts & {
  /** Set when this run's give-up put later writes on the silent fallback gap */
  starvationFallback: { quietGapAfterWriteMs: number } | undefined;
};

export function afterConfirmRun(
  state: SchedulerState,
  decodedByQuery: Partial<Record<SettingsQueryCommandName, DecodedFields>>,
  nowMs: number
): { state: SchedulerState; result: ConfirmOutcome } {
  const confirm = state.confirm;
  if (!confirm) {
    // Can't happen (only called after a run_confirms decision) — but if it does, don't invent state
    const nothing = { confirmedChecks: [], gaveUpChecks: [], notYetJudgedChecks: [], retry: undefined };
    return { state, result: { ...nothing, starvationFallback: undefined } };
  }
  const verdicts = judgeConfirmRun(confirm, state.timing, decodedByQuery, state.fieldWriteChains, nowMs);
  const startsStarvationFallback =
    confirm.strategy === "interleaved" &&
    verdicts.gaveUpChecks.length > 0 &&
    state.timing.quietGapAfterWriteMs === 0 &&
    !state.starvationFallback;
  const result: ConfirmOutcome = {
    ...verdicts,
    starvationFallback: startsStarvationFallback
      ? { quietGapAfterWriteMs: state.timing.starvationFallbackQuietGapMs }
      : undefined,
  };
  const afterVerdicts = { ...state, starvationFallback: state.starvationFallback || startsStarvationFallback };
  const retry = verdicts.retry;
  if (!retry) return { state: { ...afterVerdicts, confirm: undefined }, result };
  // Interleaved re-checks run only what the pending checks need (the refresh queries ran on the
  // first run) — not BATS every 4 s for a GPMP write; the silent path keeps its full union
  const queries =
    confirm.strategy === "interleaved" ? [...new Set(retry.pendingChecks.map(check => check.query))] : confirm.queries;
  const attemptsMade = confirm.attemptsMade + 1;
  return {
    state: {
      ...afterVerdicts,
      confirm: { ...confirm, attemptsMade, dueAt: retry.retryAt, checks: retry.pendingChecks, queries },
    },
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
