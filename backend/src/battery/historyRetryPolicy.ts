// Pure retry/escalation policy for the InfluxDB history queries the SOC ledger needs at startup (the
// anchor restore and the pre-boot charge integral). No runtime imports, so historyRetryPolicy.selftest.ts
// exercises it without a database; the runtime side lives in historyQueryRetrier.ts / influxHistoryOutage.ts.
// All times are on one monotonic timeline (the monitor passes performance.now()).

export type HistoryRetryTiming = {
  firstRetryDelayMs: number;
  maxRetryDelayMs: number;
  /** The longest one attempt can take to fail: node-influx's requestTimeout (30 s by default, pool.js). */
  requestTimeoutMs: number;
  /** An outage episode lasting this long escalates to one errorLog (= a P2 push). */
  escalateAfterMs: number;
  /** Minimum gap between the rate-limited per-failure warnLogs. */
  warnEveryMs: number;
};

export const DEFAULT_HISTORY_RETRY_TIMING: HistoryRetryTiming = {
  // The pi and the InfluxDB VM both run off the inverter's AC output, and the VM answers 7–10 min after the
  // pi boots, so every power cycle opens with an outage. A retry is one cheap failed request per query, so
  // the cap stays low: InfluxDB is seen within a minute of coming back, which bounds both the unknown-SOC
  // window and how stale the escalation's "still down" can be. The 30 s floor outlasts node-influx's own
  // host-disable backoff (10 s cap), so every retry actually reaches the network instead of failing
  // locally with "No host available".
  firstRetryDelayMs: 30_000,
  maxRetryDelayMs: 60_000,
  requestTimeoutMs: 30_000,
  // Clear of the VM's normal boot delay, so a routine power cycle never pages anyone.
  escalateAfterMs: 15 * 60_000,
  warnEveryMs: 60_000,
};

/** One stretch of history-query failures, from the first failure until a query answers or they stop. */
export type OutageEpisode = {
  startedAtMs: number;
  lastFailureAtMs: number;
  failedAttempts: number;
  escalated: boolean;
};

/** Delay before retrying a query that has now failed `failedAttempts` times in a row: doubling, capped. */
export function retryDelayAfterFailures(failedAttempts: number, timing: HistoryRetryTiming): number {
  const doublings = Math.max(0, failedAttempts - 1);
  return Math.min(timing.maxRetryDelayMs, timing.firstRetryDelayMs * 2 ** doublings);
}

/**
 * The episode after one more failure. The first failure opens it; so does one after the previous episode
 * went quiet, so a later outage gets its own escalation clock instead of being counted into a stale one.
 */
export function episodeAfterFailure(
  episode: OutageEpisode | undefined,
  nowMs: number,
  timing: HistoryRetryTiming
): OutageEpisode {
  if (!episode || episodeHasGoneQuiet(episode, nowMs, timing)) {
    return { startedAtMs: nowMs, lastFailureAtMs: nowMs, failedAttempts: 1, escalated: false };
  }
  return { ...episode, lastFailureAtMs: nowMs, failedAttempts: episode.failedAttempts + 1 };
}

/**
 * True once no failure has arrived for longer than a still-retrying query can stay silent — twice its
 * worst gap (a full-cap wait plus an attempt that runs into the request timeout). The episode is then over
 * without having been answered: its failing queries were cancelled (superseded by a live anchor, or the
 * InfluxDB client went away), so there is no outage left to report. A main() crash-restart re-queries
 * within seconds, so the clock survives those.
 */
export function episodeHasGoneQuiet(episode: OutageEpisode, nowMs: number, timing: HistoryRetryTiming): boolean {
  return nowMs - episode.lastFailureAtMs > 2 * (timing.maxRetryDelayMs + timing.requestTimeoutMs);
}

/**
 * How long until the episode should escalate: ≤ 0 means now, undefined means never (no episode open, or it
 * already escalated — one errorLog per episode, however long it lasts).
 */
export function msUntilEscalation(
  episode: OutageEpisode | undefined,
  nowMs: number,
  timing: HistoryRetryTiming
): number | undefined {
  if (!episode || episode.escalated) return undefined;
  return episode.startedAtMs + timing.escalateAfterMs - nowMs;
}

/** "850 ms" / "42 s" / "9.4 min" — for the wait/outage log lines. */
export function describeDurationMs(durationMs: number): string {
  if (durationMs < 1000) return `${Math.round(durationMs)} ms`;
  if (durationMs < 60_000) return `${Math.round(durationMs / 1000)} s`;
  return `${(durationMs / 60_000).toFixed(1)} min`;
}
