import { onCleanup } from "solid-js";
import { setTimeout as sleep } from "timers/promises";
import { retryDelayAfterFailures } from "./historyRetryPolicy.ts";
import type { InfluxHistoryOutageMonitor } from "./influxHistoryOutage.ts";

export type HistoryQueryRetrier = {
  /**
   * Runs `runQuery` until InfluxDB answers, backing off between failures, and resolves undefined instead if
   * the run is cancelled. A failing query is retried rather than rejected, so a resource fetching through
   * this can't end up errored — reading an errored resource throws, which is what crash-looped main().
   */
  run: <Value>(runQuery: () => Promise<Value>) => Promise<Value | undefined>;
  /** Stops the pending run's retries: its inputs changed, so its answer would be discarded anyway. */
  cancelPending: () => void;
};

/**
 * One retrying InfluxDB history query slot. A new run supersedes the pending one, and disposing the owner
 * (index.ts's crash-restart loop) stops it — an orphaned retry loop would otherwise keep querying, and
 * reporting to the process-wide outage monitor, on behalf of a main() that no longer exists.
 */
export function createHistoryQueryRetrier({
  description,
  outageMonitor,
}: {
  description: string;
  outageMonitor: InfluxHistoryOutageMonitor;
}): HistoryQueryRetrier {
  const pending: { run: AbortController | undefined } = { run: undefined };
  onCleanup(() => pending.run?.abort());
  return {
    run: <Value>(runQuery: () => Promise<Value>) => {
      pending.run?.abort();
      const thisRun = new AbortController();
      pending.run = thisRun;
      return queryUntilAnswered({ runQuery, description, outageMonitor, signal: thisRun.signal });
    },
    cancelPending: () => pending.run?.abort(),
  };
}

async function queryUntilAnswered<Value>({
  runQuery,
  description,
  outageMonitor,
  signal,
}: {
  runQuery: () => Promise<Value>;
  description: string;
  outageMonitor: InfluxHistoryOutageMonitor;
  signal: AbortSignal;
}): Promise<Value | undefined> {
  let failedAttempts = 0;
  while (!signal.aborted) {
    try {
      const answer = await runQuery();
      // A cancelled run's outcome is moot either way — its caller has moved on or no longer exists.
      if (signal.aborted) return undefined;
      outageMonitor.reportAnswer(description);
      return answer;
    } catch (error) {
      if (signal.aborted) return undefined;
      failedAttempts++;
      const retryInMs = retryDelayAfterFailures(failedAttempts, outageMonitor.timing);
      outageMonitor.reportFailure({ description, error, retryInMs });
      if (!(await waitUnlessCancelled(retryInMs, signal))) return undefined;
    }
  }
  return undefined;
}

/** True once the delay has passed, false if the run was cancelled during it. */
async function waitUnlessCancelled(delayMs: number, signal: AbortSignal): Promise<boolean> {
  try {
    await sleep(delayMs, undefined, { signal });
    return true;
  } catch (error) {
    // The abort is the expected way out; anything else is a real fault and must stay loud.
    if (signal.aborted) return false;
    throw error;
  }
}
