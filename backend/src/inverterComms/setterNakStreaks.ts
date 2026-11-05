/**
 * How the session logs a setter the inverter NAKs: the first NAK of a streak is an errorLog (a P2
 * candidate), the repeats warnLogs with their count, and the parameter's next ACK ends the streak. A
 * consumer that re-asserts a refused target every minute must not page every minute: feeding's EDF1 while
 * the DM050 of 2026-11-05 had turned battery discharge to the loads off. Streaks are per setter parameter
 * (the queue item's replacesPrefix), so EDF1 and EDF0 are one.
 */
import { errorLog, logLog, warnLog } from "../utilities/logging.ts";

/** Consecutive NAKs per setter parameter */
export type SetterNakStreaks = Map<string, number>;

export function reportSetterNak(
  streaks: SetterNakStreaks,
  { parameter, command, answeredAfterWriteMs }: { parameter: string; command: string; answeredAfterWriteMs: number }
): void {
  const naksInARow = (streaks.get(parameter) ?? 0) + 1;
  streaks.set(parameter, naksInARow);
  const details = ["— settings unchanged", `(answered in ${Math.round(answeredAfterWriteMs)} ms)`];
  if (naksInARow === 1) errorLog("Inverter REJECTED (NAK)", command, ...details);
  else warnLog("Inverter REJECTED (NAK)", command, ...details, `— ${naksInARow} NAKs of ${parameter} in a row`);
}

export function endSetterNakStreak(
  streaks: SetterNakStreaks,
  { parameter, command }: { parameter: string; command: string }
): void {
  const naksInARow = streaks.get(parameter);
  if (naksInARow === undefined) return;
  streaks.delete(parameter);
  logLog("Inverter ACKed", command, `after ${naksInARow} NAK(s) of ${parameter} in a row`);
}
