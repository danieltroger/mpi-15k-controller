/**
 * The verdicts one confirm run reaches on a confirm phase's pending checks, per strategy — pure.
 * afterConfirmRun (schedulerCore.ts) turns them into the next scheduler state.
 */
import type { DecodedFields, SettingsQueryCommandName } from "./pi17Protocol.types.ts";
import type { ConfirmPhase, PendingReadbackCheck } from "./schedulerCore.ts";
import { checkIsSatisfied } from "./setterConfirmation.ts";
import { MAX_CONFIRM_ATTEMPTS, type SchedulerTiming } from "./schedulerTiming.ts";

/**
 * Every check of the phase gets a verdict or stays pending. Confirmed and given-up checks leave the
 * phase; when none is left pending (`retry` undefined) the phase is over.
 */
export type ConfirmVerdicts = {
  /** The readback shows these applied */
  confirmedChecks: readonly PendingReadbackCheck[];
  /** Still the old value with no attempt left — the loud "never applied" */
  gaveUpChecks: readonly PendingReadbackCheck[];
  /** Interleaved: written too recently for this readback to speak for them; pending, not counted as still old */
  notYetJudgedChecks: readonly PendingReadbackCheck[];
  /** Still the old value or not yet judged, re-checked at retryAt */
  retry: { pendingChecks: readonly PendingReadbackCheck[]; retryAt: number } | undefined;
};

export function judgeConfirmRun(
  confirm: ConfirmPhase,
  timing: Readonly<SchedulerTiming>,
  decodedByQuery: Partial<Record<SettingsQueryCommandName, DecodedFields>>,
  nowMs: number
): ConfirmVerdicts {
  // A write merged into a running interleaved cadence can come up for a confirm right after it went
  // out. A readback that early says nothing about it: after 350→550→350 the pre-550 value would
  // "confirm" the second 350 while the 550 is still on its way.
  const notYetJudgedChecks =
    confirm.strategy === "interleaved" ? confirm.checks.filter(check => nowMs < firstJudgeableAt(timing, check)) : [];
  const judgedChecks = confirm.checks.filter(check => !notYetJudgedChecks.includes(check));
  const confirmedChecks = judgedChecks.filter(check => checkIsSatisfied(check, decodedByQuery));
  const stillOldChecks = judgedChecks.filter(check => !checkIsSatisfied(check, decodedByQuery));
  const { gaveUpChecks, retry } =
    confirm.strategy === "silent"
      ? silentVerdicts(timing, stillOldChecks, confirm.attemptsMade + 1, nowMs)
      : interleavedVerdicts(timing, stillOldChecks, notYetJudgedChecks, nowMs);
  return { confirmedChecks, gaveUpChecks, notYetJudgedChecks, retry };
}

type StillOldVerdicts = Pick<ConfirmVerdicts, "gaveUpChecks" | "retry">;

/** One confirm after the quiet gap, one re-check after the silent backoff, then the whole phase gives up */
function silentVerdicts(
  timing: Readonly<SchedulerTiming>,
  stillOldChecks: readonly PendingReadbackCheck[],
  attemptsMade: number,
  nowMs: number
): StillOldVerdicts {
  if (!stillOldChecks.length) return { gaveUpChecks: [], retry: undefined };
  if (attemptsMade >= MAX_CONFIRM_ATTEMPTS) return { gaveUpChecks: stillOldChecks, retry: undefined };
  return { gaveUpChecks: [], retry: { pendingChecks: stillOldChecks, retryAt: nowMs + timing.confirmBackoffMs } };
}

/**
 * Each check gives up at its own deadline (its write + the give-up window), so a burst merging a
 * later write into the phase can't postpone an earlier write's verdict past its identical-setter
 * gate. The next run lands no later than the earliest remaining deadline, nor than the moment a
 * not-yet-judged check becomes judgeable.
 */
function interleavedVerdicts(
  timing: Readonly<SchedulerTiming>,
  stillOldChecks: readonly PendingReadbackCheck[],
  notYetJudgedChecks: readonly PendingReadbackCheck[],
  nowMs: number
): StillOldVerdicts {
  const gaveUpChecks = stillOldChecks.filter(check => nowMs >= interleavedGiveUpAt(timing, check));
  const recheckedChecks = stillOldChecks.filter(check => nowMs < interleavedGiveUpAt(timing, check));
  const pendingChecks = [...recheckedChecks, ...notYetJudgedChecks];
  if (!pendingChecks.length) return { gaveUpChecks, retry: undefined };
  const retryAt = Math.min(
    nowMs + timing.interleavedConfirmIntervalMs,
    ...recheckedChecks.map(check => interleavedGiveUpAt(timing, check)),
    ...notYetJudgedChecks.map(check => firstJudgeableAt(timing, check))
  );
  return { gaveUpChecks, retry: { pendingChecks, retryAt } };
}

/** An interleaved check is judged no earlier than its own first-confirm window after its write */
function firstJudgeableAt(timing: Readonly<SchedulerTiming>, check: PendingReadbackCheck): number {
  return check.writtenAtMs + timing.firstInterleavedConfirmAfterWriteMs;
}

function interleavedGiveUpAt(timing: Readonly<SchedulerTiming>, check: PendingReadbackCheck): number {
  return check.writtenAtMs + timing.interleavedConfirmGiveUpAfterWriteMs;
}
