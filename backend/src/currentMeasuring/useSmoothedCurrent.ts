import { type Accessor, createMemo } from "solid-js";

/**
 * Trailing rolling mean of an amp signal over `windowMs` (default 60 s). Anchor detection wants a
 * 1-min-smoothed hall current so a single noisy ADC sample can't declare the pack full or trip a
 * soft-empty crossing. Kept O(1) per sample with a running sum. Emits undefined until the first
 * sample arrives, then always the mean of whatever falls inside the window.
 */
export function useSmoothedCurrent({
  rawCurrent,
  windowMs = 60_000,
}: {
  rawCurrent: Accessor<{ value: number; time: number } | undefined>;
  windowMs?: number;
}): Accessor<number | undefined> {
  const samples: { value: number; time: number }[] = [];
  let runningSum = 0;

  return createMemo<number | undefined>(prev => {
    const current = rawCurrent();
    if (!current) return prev;
    samples.push(current);
    runningSum += current.value;
    const cutoff = current.time - windowMs;
    while (samples.length > 1 && samples[0].time < cutoff) {
      runningSum -= samples[0].value;
      samples.shift();
    }
    return runningSum / samples.length;
  });
}
