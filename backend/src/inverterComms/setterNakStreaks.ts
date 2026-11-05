/**
 * How the session logs a setter the inverter NAKs: the first NAK of a streak is an errorLog (a P2
 * candidate), the repeats warnLogs with their count, a streak still running errorLogs again every
 * NAK_STREAK_REPAGE_INTERVAL_MS, and the parameter's next ACK, or a quiet NAK_STREAK_EXPIRES_AFTER_MS,
 * ends it. A consumer that re-asserts a refused target every minute must not page every minute: feeding's
 * EDF1 while the DM050 of 2026-11-05 had turned battery discharge to the loads off. Many recoveries bring no
 * ACK (the target moves to what the readback shows and is dropped unsent), so without the expiry a NAK
 * days later would only ever be a warnLog. Streaks are per setter parameter (the queue item's
 * replacesPrefix), so EDF1 and EDF0 are one. Times are the session's monotonic clock.
 */
import { errorLog, logLog, warnLog } from "../utilities/logging.ts";

/**
 * A NAK this long after the parameter's previous one starts a new streak: well past any consumer's retry
 * cadence (a minute, the energy-distribution fallback's 10 min), short of "a new problem days later"
 */
export const NAK_STREAK_EXPIRES_AFTER_MS = 30 * 60_000;
/** A streak still running errorLogs again this often, with its count (each a P2 candidate) */
export const NAK_STREAK_REPAGE_INTERVAL_MS = 60 * 60_000;

export type SetterNakStreak = { count: number; lastNakAtMs: number; lastErrorLogAtMs: number };

/** The running streak per setter parameter */
export type SetterNakStreaks = Map<string, SetterNakStreak>;

export function reportSetterNak(
  streaks: SetterNakStreaks,
  {
    parameter,
    command,
    answeredAfterWriteMs,
    nowMs,
  }: { parameter: string; command: string; answeredAfterWriteMs: number; nowMs: number }
): void {
  const previous = streaks.get(parameter);
  const details = ["— settings unchanged", `(answered in ${Math.round(answeredAfterWriteMs)} ms)`];
  if (!previous || nowMs - previous.lastNakAtMs > NAK_STREAK_EXPIRES_AFTER_MS) {
    streaks.set(parameter, { count: 1, lastNakAtMs: nowMs, lastErrorLogAtMs: nowMs });
    errorLog("Inverter REJECTED (NAK)", command, ...details);
    return;
  }
  const count = previous.count + 1;
  if (nowMs - previous.lastErrorLogAtMs >= NAK_STREAK_REPAGE_INTERVAL_MS) {
    streaks.set(parameter, { count, lastNakAtMs: nowMs, lastErrorLogAtMs: nowMs });
    errorLog("Inverter REJECTED (NAK)", command, ...details, `— still refused: ${count} NAKs of ${parameter} in a row`);
    return;
  }
  streaks.set(parameter, { ...previous, count, lastNakAtMs: nowMs });
  warnLog("Inverter REJECTED (NAK)", command, ...details, `— ${count} NAKs of ${parameter} in a row`);
}

export function endSetterNakStreak(
  streaks: SetterNakStreaks,
  { parameter, command }: { parameter: string; command: string }
): void {
  const streak = streaks.get(parameter);
  if (streak === undefined) return;
  streaks.delete(parameter);
  logLog("Inverter ACKed", command, `after ${streak.count} NAK(s) of ${parameter} in a row`);
}
