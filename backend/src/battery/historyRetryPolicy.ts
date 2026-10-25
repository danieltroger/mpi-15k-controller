// Pure retry/escalation policy for the InfluxDB history queries the SOC ledger needs at startup (the
// anchor restore and the pre-boot charge integral). No runtime imports, so historyRetryPolicy.selftest.ts
// exercises it without a database; the runtime side lives in historyQueryRetrier.ts / influxHistoryOutage.ts.

export type HistoryRetryTiming = {
  firstRetryDelayMs: number;
  maxRetryDelayMs: number;
  /** An outage episode lasting this long escalates to one errorLog (= a P2 push). */
  escalateAfterMs: number;
  /** Minimum gap between the rate-limited per-failure warnLogs. */
  warnEveryMs: number;
};

export const DEFAULT_HISTORY_RETRY_TIMING: HistoryRetryTiming = {
  // The pi and the InfluxDB VM both run off the inverter's AC output, and the VM answers 7–10 min after the
  // pi boots, so every power cycle opens with an outage. Doubling from 30 s keeps the SOC within a few
  // minutes of Influx answering without hammering a VM that is still booting. The 30 s floor also outlasts
  // node-influx's own host-disable backoff (10 s cap), so every retry actually reaches the network instead
  // of failing locally with "No host available".
  firstRetryDelayMs: 30_000,
  maxRetryDelayMs: 5 * 60_000,
  // Clear of the VM's normal boot delay, so a routine power cycle never pages anyone.
  escalateAfterMs: 15 * 60_000,
  warnEveryMs: 60_000,
};

/** One stretch of consecutive history-query failures, from the first failure until any query answers. */
export type OutageEpisode = { startedAtMs: number; failedAttempts: number; escalated: boolean };

/** Delay before retrying a query that has now failed `failedAttempts` times in a row: doubling, capped. */
export function retryDelayAfterFailures(failedAttempts: number, timing: HistoryRetryTiming): number {
  const doublings = Math.max(0, failedAttempts - 1);
  return Math.min(timing.maxRetryDelayMs, timing.firstRetryDelayMs * 2 ** doublings);
}

/** The episode after one more failure: the first failure opens it, later ones only count. */
export function episodeAfterFailure(episode: OutageEpisode | undefined, nowMs: number): OutageEpisode {
  if (!episode) return { startedAtMs: nowMs, failedAttempts: 1, escalated: false };
  return { ...episode, failedAttempts: episode.failedAttempts + 1 };
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
