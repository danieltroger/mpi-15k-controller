/**
 * The verdicts one confirm run reaches on a confirm phase's pending checks — pure.
 * afterConfirmRun (schedulerCore.ts) turns them into the next scheduler state.
 */
import type { DecodedFields, SettingsQueryCommandName } from "./pi17Protocol.types.ts";
import type { ConfirmPhase, PendingReadbackCheck } from "./schedulerCore.ts";
import { checkIsSatisfied } from "./setterConfirmation.ts";
import { readbackFieldKey, readbackProvesWrite, type FieldWriteChains } from "./fieldWriteChains.ts";
import type { SchedulerTiming } from "./schedulerTiming.ts";

/**
 * Every check of the phase gets a verdict or stays pending. Confirmed and given-up checks leave the
 * phase; when none is left pending (`retry` undefined) the phase is over.
 */
export type ConfirmVerdicts = {
  /** The readback shows these applied */
  confirmedChecks: readonly PendingReadbackCheck[];
  /** Still the old value at their give-up — the loud "never applied" */
  gaveUpChecks: readonly PendingReadbackCheck[];
  /** Written too recently for this readback to speak for them; pending, not counted as still old */
  notYetJudgedChecks: readonly PendingReadbackCheck[];
  /** Still the old value or not yet judged, re-checked at retryAt */
  retry: { pendingChecks: readonly PendingReadbackCheck[]; retryAt: number } | undefined;
};

/**
 * Each check gives up at its own deadline (its write + the give-up window), so a burst merging a
 * later write into the phase can't postpone an earlier write's verdict past its identical-setter
 * gate. The next run lands no later than the earliest remaining deadline, nor than the moment a
 * not-yet-judged check becomes judgeable.
 */
export function judgeConfirmRun(
  confirm: ConfirmPhase,
  timing: Readonly<SchedulerTiming>,
  decodedByQuery: Partial<Record<SettingsQueryCommandName, DecodedFields>>,
  fieldWriteChains: FieldWriteChains,
  { runStartedAtMs, nowMs }: { runStartedAtMs: number; nowMs: number }
): ConfirmVerdicts {
  // A write merged into a running confirm cadence can come up for a confirm right after it went
  // out. A readback that early says nothing about it: after 350→550→350 the pre-550 value would
  // "confirm" the second 350 while the 550 is still on its way. Judged against the run's START: a
  // readback decoded early in a run that a slow later query drags out is still that early.
  const notYetJudgedChecks = confirm.checks.filter(check => runStartedAtMs < firstJudgeableAt(timing, check));
  const judgedChecks = confirm.checks.filter(check => !notYetJudgedChecks.includes(check));
  // A readback showing the target but not provably from this write (A→B→A, B not yet seen) is
  // no better than a still-old one: re-checked, and given up on if it never resolves
  const confirmedChecks = judgedChecks.filter(check => readbackProvesCheck(check, decodedByQuery, fieldWriteChains));
  const stillOldChecks = judgedChecks.filter(check => !confirmedChecks.includes(check));
  const gaveUpChecks = stillOldChecks.filter(check => nowMs >= giveUpAt(timing, check));
  const recheckedChecks = stillOldChecks.filter(check => nowMs < giveUpAt(timing, check));
  const pendingChecks = [...recheckedChecks, ...notYetJudgedChecks];
  if (!pendingChecks.length) return { confirmedChecks, gaveUpChecks, notYetJudgedChecks, retry: undefined };
  const retryAt = Math.min(
    nowMs + timing.confirmRecheckIntervalMs,
    ...recheckedChecks.map(check => giveUpAt(timing, check)),
    ...notYetJudgedChecks.map(check => firstJudgeableAt(timing, check))
  );
  return { confirmedChecks, gaveUpChecks, notYetJudgedChecks, retry: { pendingChecks, retryAt } };
}

function readbackProvesCheck(
  check: PendingReadbackCheck,
  decodedByQuery: Partial<Record<SettingsQueryCommandName, DecodedFields>>,
  fieldWriteChains: FieldWriteChains
): boolean {
  if (!checkIsSatisfied(check, decodedByQuery)) return false;
  return readbackProvesWrite(
    fieldWriteChains[readbackFieldKey(check.query, check.field)],
    { value: check.expectedValue, sentAtMs: check.writtenAtMs },
    decodedByQuery[check.query]?.[check.field]
  );
}

/** A check is judged no earlier than its own first-confirm window after its write */
function firstJudgeableAt(timing: Readonly<SchedulerTiming>, check: PendingReadbackCheck): number {
  return check.writtenAtMs + timing.firstConfirmAfterWriteMs;
}

function giveUpAt(timing: Readonly<SchedulerTiming>, check: PendingReadbackCheck): number {
  return check.writtenAtMs + timing.confirmGiveUpAfterWriteMs;
}
