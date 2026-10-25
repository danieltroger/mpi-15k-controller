import { warnLog } from "./logging.ts";

/**
 * A warnLog that speaks at most once per `minIntervalMs` and reports how many occurrences it
 * swallowed in between — for per-chunk/per-frame anomalies that would otherwise flood the log
 * (the first native-serial cutover printed ~20 "Discarded N stray byte(s)" lines per second).
 * The first occurrence is always logged; nothing is dropped without being counted.
 */
export function createRateLimitedWarnLog(minIntervalMs: number) {
  let lastLoggedAt = -Infinity;
  let suppressedSinceLastLog = 0;
  return function rateLimitedWarnLog(...args: any[]) {
    const now = Date.now();
    if (now - lastLoggedAt < minIntervalMs) {
      suppressedSinceLastLog++;
      return;
    }
    if (suppressedSinceLastLog) {
      warnLog(...args, `(+${suppressedSinceLastLog} similar suppressed since the previous report)`);
    } else {
      warnLog(...args);
    }
    lastLoggedAt = now;
    suppressedSinceLastLog = 0;
  };
}
