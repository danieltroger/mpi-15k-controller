/**
 * The buy-window end step-down's last phase, pure: EDB0 is allowed, and the step-down waits for a HECS
 * readback newer than the release to show AC charging disabled — re-asking for EDB0 a bounded number
 * of times if it doesn't. The phases before it: buyWindowEndStepDown.ts.
 */
import type {
  BuyWindowEndInputs,
  BuyWindowEndStepDownState,
  StepDownEvent,
  StepDownProgress,
} from "./buyWindowEndStepDown.ts";

/**
 * After EDB0 is released, a HECS readback that still shows AC charging enabled this long after the last
 * EDB0 request asks for EDB0 again: #48's confirm (12 s) and its backoff re-check (30 s more) are over
 * by then, and the identical-setter gate wouldn't send it any sooner anyway.
 */
export const EDB0_RETRY_SPACING_MS = 60_000;
/** EDB0 re-requests before giving up loudly (errorLog); AC charging then stays on until the next window */
export const MAX_EDB0_RETRIES = 2;

export type Released = {
  phase: "released";
  startedAtMs: number;
  releasedAtMs: number;
  edb0Retries: number;
  lastEdb0RequestAtMs: number;
  edb0RetriesExhausted: boolean;
};

export function releasedAt(startedAtMs: number, nowMs: number): Released {
  return {
    phase: "released",
    startedAtMs,
    releasedAtMs: nowMs,
    edb0Retries: 0,
    lastEdb0RequestAtMs: nowMs,
    edb0RetriesExhausted: false,
  };
}

export function whileReleased(
  progress: Released,
  inputs: Pick<BuyWindowEndInputs, "gridChargingWanted" | "acChargingReadback" | "limitReadback">,
  nowMs: number,
  events: StepDownEvent[]
): StepDownProgress {
  const afterReleaseMs = nowMs - progress.releasedAtMs;
  if (inputs.gridChargingWanted) {
    events.push({ kind: "release_superseded", afterReleaseMs });
    return { phase: "idle" };
  }
  const reading = inputs.acChargingReadback;
  // Only a readback newer than the release can show what EDB0 did (an older "disabled" may be the
  // stale pre-window one that started this step-down)
  if (!reading || reading.observedAtMs <= progress.releasedAtMs) return progress;
  if (reading.state === "disabled") {
    events.push({ kind: "ac_charging_disabled_confirmed", afterMs: nowMs - progress.startedAtMs, afterReleaseMs });
    return { phase: "idle" };
  }
  const retryDue = reading.observedAtMs > progress.lastEdb0RequestAtMs + EDB0_RETRY_SPACING_MS;
  if (!retryDue || progress.edb0RetriesExhausted) return progress;
  if (progress.edb0Retries >= MAX_EDB0_RETRIES) {
    events.push({
      kind: "edb0_retries_exhausted",
      afterReleaseMs,
      attempts: progress.edb0Retries,
      lastLimitReadbackAmps: inputs.limitReadback?.amps,
    });
    return { ...progress, edb0RetriesExhausted: true };
  }
  events.push({ kind: "edb0_retry", afterReleaseMs, attempt: progress.edb0Retries + 1 });
  return { ...progress, edb0Retries: progress.edb0Retries + 1, lastEdb0RequestAtMs: nowMs };
}

/** Grows by one each time the released step-down wants EDB0 queued again (bounded by MAX_EDB0_RETRIES) */
export function edb0RetryRequests(state: BuyWindowEndStepDownState): number {
  return state.progress.phase === "released" ? state.progress.edb0Retries : 0;
}
