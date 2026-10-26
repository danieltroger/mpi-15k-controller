import { errorLog, logLog } from "../utilities/logging.ts";
import { createRateLimitedWarnLog } from "../utilities/rateLimitedWarnLog.ts";
import {
  DEFAULT_HISTORY_RETRY_TIMING,
  describeDurationMs,
  episodeAfterFailure,
  episodeHasGoneQuiet,
  type HistoryRetryTiming,
  msUntilEscalation,
  type OutageEpisode,
} from "./historyRetryPolicy.ts";

export type HistoryQueryFailure = { description: string; error: unknown; retryInMs: number };

/** Where every retrying history query reports, so an outage is logged and escalated once, not per query. */
export type InfluxHistoryOutageMonitor = {
  timing: HistoryRetryTiming;
  reportFailure: (failure: HistoryQueryFailure) => void;
  reportAnswer: (description: string) => void;
  /** The open outage episode, if any (for diagnostics and the selftests). */
  currentEpisode: () => OutageEpisode | undefined;
};

type MonitorState = {
  episode: OutageEpisode | undefined;
  lastFailure: HistoryQueryFailure | undefined;
  escalationTimer: ReturnType<typeof setTimeout> | undefined;
};

/**
 * Turns the individual history-query failures into one outage story: a rate-limited warnLog per failure,
 * one errorLog (P2) if the outage outlasts `escalateAfterMs`, and a log line when InfluxDB answers again.
 * Durations are monotonic (performance.now()): this runs exactly while the pi's wall clock is stale and
 * about to step forward by however long the power was out.
 */
export function createInfluxHistoryOutageMonitor(timing: HistoryRetryTiming): InfluxHistoryOutageMonitor {
  const monitorState: MonitorState = { episode: undefined, lastFailure: undefined, escalationTimer: undefined };
  const warnAboutFailure = createRateLimitedWarnLog(timing.warnEveryMs);
  return {
    timing,
    reportFailure: failure => recordFailure({ monitorState, timing, warnAboutFailure, failure }),
    reportAnswer: description => recordAnswer(monitorState, description),
    currentEpisode: () => monitorState.episode,
  };
}

/**
 * The monitor the battery code reports to. Module-level on purpose: an InfluxDB outage outlives a main()
 * crash-restart (index.ts), and the escalation clock has to keep running across those rather than start
 * over with every restart.
 */
export const influxHistoryOutage = createInfluxHistoryOutageMonitor(DEFAULT_HISTORY_RETRY_TIMING);

function recordFailure({
  monitorState,
  timing,
  warnAboutFailure,
  failure,
}: {
  monitorState: MonitorState;
  timing: HistoryRetryTiming;
  warnAboutFailure: ReturnType<typeof createRateLimitedWarnLog>;
  failure: HistoryQueryFailure;
}) {
  monitorState.episode = episodeAfterFailure(monitorState.episode, performance.now(), timing);
  monitorState.lastFailure = failure;
  warnAboutFailure(
    `InfluxDB history query failed (${failure.description}), retrying in ${describeDurationMs(failure.retryInMs)}; the SOC stays unknown until the history answers`,
    failure.error
  );
  if (monitorState.episode.failedAttempts === 1) {
    // A fresh episode, possibly replacing one that had gone quiet: its escalation clock starts now.
    clearTimeout(monitorState.escalationTimer);
    checkEscalation(monitorState, timing);
  }
}

function recordAnswer(monitorState: MonitorState, description: string) {
  const endedEpisode = monitorState.episode;
  if (!endedEpisode) return;
  monitorState.episode = undefined;
  clearTimeout(monitorState.escalationTimer);
  logLog(
    `InfluxDB history answering again (${description}) after ${describeDurationMs(performance.now() - endedEpisode.startedAtMs)} and ${endedEpisode.failedAttempts} failed attempt(s)`
  );
}

function checkEscalation(monitorState: MonitorState, timing: HistoryRetryTiming) {
  const episode = monitorState.episode;
  if (!episode) return;
  const nowMs = performance.now();
  if (episodeHasGoneQuiet(episode, nowMs, timing)) {
    monitorState.episode = undefined;
    logLog(
      `InfluxDB history: no query has failed for ${describeDurationMs(nowMs - episode.lastFailureAtMs)} — the failing ones were cancelled, not answered; closing the outage episode without escalating`
    );
    return;
  }
  const waitMs = msUntilEscalation(episode, nowMs, timing);
  if (waitMs === undefined) return;
  if (waitMs > 0) {
    // Re-check when the timer fires rather than trusting it: it rounds to whole ms, and by then the
    // episode may have gone quiet instead.
    monitorState.escalationTimer = setTimeout(() => checkEscalation(monitorState, timing), waitMs);
    return;
  }
  monitorState.episode = { ...episode, escalated: true };
  errorLog(
    `InfluxDB history queries have failed for ${describeDurationMs(nowMs - episode.startedAtMs)} (${episode.failedAttempts} attempts, latest: ${monitorState.lastFailure?.description}) — the SOC can't be restored, so SOC-based buying, selling, battery feeding and planning stay paused until InfluxDB answers`,
    monitorState.lastFailure?.error
  );
}
