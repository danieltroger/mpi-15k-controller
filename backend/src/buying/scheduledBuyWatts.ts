import { type Accessor, createEffect, createMemo, createSignal, mapArray } from "solid-js";
import { batchedRunAtFutureTimeWithPriority } from "../utilities/batchedRunAtFutureTimeWithPriority.ts";
import type { Config } from "../config/config.types.ts";

type BuySchedule = Config["scheduled_power_buying"]["schedule"];

/**
 * Each buy schedule entry's currently wanted watts (0 outside its window), in the schedule's key order, for
 * useShouldBuyPower. An entry is keyed by its start, so mapArray keeps one item per key: a re-plan that only
 * moves an entry's end_time (runningHold.ts reshaping a running hold) re-runs that item's effect instead of
 * replacing the item, and the wanted watts never pass through 0 in between. The re-run's cleanup removes the
 * old end timer (batchedRunAtFutureTimeWithPriority's onCleanup) and arms one at the new end; the clock is read
 * inside the effect, so the re-run judges the window from now rather than from when the item was created.
 */
export function scheduledBuyWattsPerEntry(schedule: Accessor<BuySchedule>): Accessor<Accessor<Accessor<number>>[]> {
  return createMemo(
    mapArray(
      () => Object.keys(schedule()),
      startTime => {
        const [wantedPower, setWantedPower] = createSignal<Accessor<number>>(() => 0);
        const scheduleItem = () => schedule()[startTime];
        const startTimestamp = +new Date(startTime);
        const memoizedEnd = createMemo(() => +new Date(scheduleItem().end_time));

        createEffect(() => {
          const end = memoizedEnd();
          const nowMs = Date.now();
          const setEndTimeout = () =>
            batchedRunAtFutureTimeWithPriority(() => setWantedPower(() => () => 0), end, false);

          // If already in the timeslot, set buying directly
          if (startTimestamp <= nowMs && nowMs <= end) {
            setWantedPower(() => () => scheduleItem().charging_power);
            setEndTimeout();
          } else if (startTimestamp > nowMs) {
            // If schedule item starts in the future, set timeout for both start and end
            batchedRunAtFutureTimeWithPriority(
              () => setWantedPower(() => () => scheduleItem().charging_power),
              startTimestamp,
              true
            );
            setEndTimeout();
          } else {
            // If schedule item has ended, set buying to 0
            setWantedPower(() => () => 0);
          }
        });
        return wantedPower;
      }
    )
  );
}
