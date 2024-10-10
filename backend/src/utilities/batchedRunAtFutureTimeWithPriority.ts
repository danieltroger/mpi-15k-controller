import { catchify } from "@depict-ai/utilishared/latest";
import { onCleanup } from "solid-js";

const timeoutBatches = new Map<
  number,
  { first: Set<VoidFunction>; last: Set<VoidFunction>; timeout: ReturnType<typeof setTimeout> }
>();

/**
 * Function that runs a function at a future time with the option to prioritize it over other, non-prioritized functions scheduled at the same time.
 * The idea is that we want to always start feeding before we stop feeding, to avoid momentarily feeding 0 which re-starts the slow rampup of the inverter.
 */
export function batchedRunAtFutureTimeWithPriority(fn: VoidFunction, when: number, prioritised: boolean) {
  const existing = timeoutBatches.get(when);
  const { first, last } = existing || { first: new Set<VoidFunction>(), last: new Set<VoidFunction>() };
  if (!existing) {
    const now = +new Date();
    const timeUntil = when - now;
    const timeout = setTimeout(
      catchify(() => {
        for (const fn of first) {
          fn();
        }
        for (const fn of last) {
          fn();
        }
        timeoutBatches.delete(when);
      }),
      timeUntil
    );
    timeoutBatches.set(when, { first, last, timeout });
  }

  const unsetTimeoutWhenEmpty = () => {
    if (first.size !== 0 || last.size !== 0) return;
    const timeoutToClear = timeoutBatches.get(when)?.timeout;
    if (timeoutToClear == undefined) return;
    clearTimeout(timeoutToClear);
    timeoutBatches.delete(when);
  };
  if (prioritised) {
    first.add(fn);
    onCleanup(() => {
      first.delete(fn);
      unsetTimeoutWhenEmpty();
    });
  } else {
    last.add(fn);
    onCleanup(() => {
      last.delete(fn);
      unsetTimeoutWhenEmpty();
    });
  }
}
