/**
 * Pure building blocks for "this has held continuously for N minutes" alerts: a three-way
 * observation tracker, and a trailing-window mean so a single sensor spike can't break a
 * sustained run. No clock reads (callers pass nowMs), so the selftest and the Influx backtest
 * drive exactly what the controller runs.
 */

/**
 * What one evaluation tick says about a failure signature:
 * - "failing": the signature is present
 * - "healthy": positive evidence that the monitored path works
 * - "indeterminate": can't tell (stale data, or a gate that excludes a legitimate look-alike)
 */
export type ConditionObservation = "failing" | "healthy" | "indeterminate";

export type SustainedConditionState = {
  active: boolean;
  /** Start of the current unbroken run of "failing" observations */
  failingSinceMs: number | undefined;
  /** Start of the current unbroken run of "healthy" observations */
  healthySinceMs: number | undefined;
  /** failingSinceMs of the run that activated the condition: the onset quoted in alerts */
  onsetMs: number | undefined;
};

export const INACTIVE_SUSTAINED_CONDITION: SustainedConditionState = {
  active: false,
  failingSinceMs: undefined,
  healthySinceMs: undefined,
  onsetMs: undefined,
};

/**
 * Activation needs `activateAfterMs` of unbroken "failing", clearing needs `clearAfterMs` of
 * unbroken "healthy". "indeterminate" breaks both runs but holds `active`: a stale or gated tick
 * must neither fire nor resolve anything, and time spent unobserved must not count towards either.
 */
export function advanceSustainedCondition(
  previous: SustainedConditionState,
  observation: ConditionObservation,
  nowMs: number,
  timing: { activateAfterMs: number; clearAfterMs: number }
): SustainedConditionState {
  if (observation === "failing") {
    const failingSinceMs = previous.failingSinceMs ?? nowMs;
    const activates = !previous.active && nowMs - failingSinceMs >= timing.activateAfterMs;
    return {
      active: previous.active || activates,
      failingSinceMs,
      healthySinceMs: undefined,
      onsetMs: activates ? failingSinceMs : previous.onsetMs,
    };
  }
  if (observation === "healthy") {
    const healthySinceMs = previous.healthySinceMs ?? nowMs;
    const clears = previous.active && nowMs - healthySinceMs >= timing.clearAfterMs;
    return {
      active: previous.active && !clears,
      failingSinceMs: undefined,
      healthySinceMs,
      onsetMs: clears ? undefined : previous.onsetMs,
    };
  }
  return { ...previous, failingSinceMs: undefined, healthySinceMs: undefined };
}

export type TimedSample = { value: number; time: number };

/** Mutable on purpose: the hall sensor feeds this at ~4 Hz, so it keeps a running sum (O(1) per sample). */
export type TrailingMeanWindow = { windowMs: number; samples: TimedSample[]; runningSum: number };

export function createTrailingMeanWindow(windowMs: number): TrailingMeanWindow {
  return { windowMs, samples: [], runningSum: 0 };
}

export function addTrailingSample(meanWindow: TrailingMeanWindow, sample: TimedSample) {
  meanWindow.samples.push(sample);
  meanWindow.runningSum += sample.value;
  pruneTrailingWindow(meanWindow, sample.time);
}

/** Mean of the samples inside the window ending at nowMs; `time` is the newest sample's, so callers can judge freshness. */
export function trailingMean(meanWindow: TrailingMeanWindow, nowMs: number): TimedSample | undefined {
  pruneTrailingWindow(meanWindow, nowMs);
  const newest = meanWindow.samples.at(-1);
  if (!newest) return undefined;
  return { value: meanWindow.runningSum / meanWindow.samples.length, time: newest.time };
}

function pruneTrailingWindow(meanWindow: TrailingMeanWindow, nowMs: number) {
  const cutoffMs = nowMs - meanWindow.windowMs;
  while (meanWindow.samples.length && meanWindow.samples[0].time < cutoffMs) {
    meanWindow.runningSum -= meanWindow.samples.shift()!.value;
  }
  // Floating-point drift of a long-lived running sum would otherwise survive an emptied window
  if (!meanWindow.samples.length) meanWindow.runningSum = 0;
}
