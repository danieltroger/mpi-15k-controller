import { Accessor, createEffect, createMemo, createSignal, indexArray, onCleanup } from "solid-js";
import { Config } from "../config";
import { log } from "../utilities/logging";
import { catchify } from "@depict-ai/utilishared/latest";

const timeoutBatches = new Map<
  number,
  { first: Set<VoidFunction>; last: Set<VoidFunction>; timeout: ReturnType<typeof setTimeout> }
>();

export function shouldSellPower(config: Accessor<Config>, averageSOC: Accessor<number | undefined>) {
  const scheduleOutput = createMemo(
    indexArray(
      () => config().scheduled_power_selling.schedule,
      schedule => {
        const [wantedOutput, setWantedOutput] = createSignal<Accessor<number>>(() => 0);
        const memoizedStart = createMemo(() => +new Date(schedule().start_time));
        const memoizedEnd = createMemo(() => +new Date(schedule().end_time));

        createEffect(() => {
          const now = +new Date();
          const start = memoizedStart();
          const end = memoizedEnd();
          const setEndTimeout = () =>
            batchedRunAtFutureTimeWithPriority(() => setTimeout(() => setWantedOutput(() => () => 0)), end, false);

          // If already in the timeslot, set feeding directly
          if (start <= now && now <= end) {
            setWantedOutput(() => () => schedule().power_watts);
            setEndTimeout();
          } else if (start > now) {
            // If schedule item starts in the future, set timeout for both start and end
            batchedRunAtFutureTimeWithPriority(() => setWantedOutput(() => () => schedule().power_watts), start, true);
            setEndTimeout();
          }

          onCleanup(() => setTimeout(() => setWantedOutput(() => () => 0)));
        });
        return wantedOutput;
      }
    )
  );

  let hitSOCLimit = false;

  const exportAmountForSelling = createMemo(() => {
    const soc = averageSOC();
    if (soc === undefined) return;
    const onlySellAboveSoc = config().scheduled_power_selling.only_sell_above_soc;
    const startSellingAgainAboveSoc = config().scheduled_power_selling.start_selling_again_above_soc;
    const limitToUse = hitSOCLimit ? startSellingAgainAboveSoc : onlySellAboveSoc;
    if (soc > limitToUse) {
      hitSOCLimit = false;
      // return the maximum value of all schedule items
      const result = Math.max(...scheduleOutput().map(schedule => schedule()()));
      if (Math.abs(result) === Infinity) {
        return 0;
      }
      return result;
    }
    hitSOCLimit = true;
    return 0;
  });

  createEffect(() => log("Feed in due to scheduled power selling wants to feed in", exportAmountForSelling(), "watts"));

  return { exportAmountForSelling };
}

/**
 * Function that runs a function at a future time with the option to prioritize it over other, non-prioritized functions scheduled at the same time.
 * The idea is that we want to always start feeding before we stop feeding, to avoid momentarily feeding 0 which re-starts the slow rampup of the inverter.
 */
function batchedRunAtFutureTimeWithPriority(fn: VoidFunction, when: number, prioritised: boolean) {
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
