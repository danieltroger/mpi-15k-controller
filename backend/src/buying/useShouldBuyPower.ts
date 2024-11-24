import { Accessor, createEffect, createMemo, createSignal, mapArray } from "solid-js";
import { Config } from "../config";
import { log } from "../utilities/logging";
import { batchedRunAtFutureTimeWithPriority } from "../utilities/batchedRunAtFutureTimeWithPriority";
import { useShouldBuyAmpsLessToNotBlowFuse } from "./useShouldBuyAmpsLessToNotBlowFuse";

export function useShouldBuyPower(config: Accessor<Config>, averageSOC: Accessor<number | undefined>) {
  const scheduleOutput = createMemo(
    mapArray(
      () => Object.keys(config().scheduled_power_buying.schedule),
      startTime => {
        const [wantedAmperage, setWantedAmperage] = createSignal<Accessor<number>>(() => 0);
        const scheduleItem = () => config().scheduled_power_buying.schedule[startTime];
        const startTimestamp = +new Date(startTime);
        const memoizedEnd = createMemo(() => +new Date(scheduleItem().end_time));
        const now = +new Date();

        createEffect(() => {
          const end = memoizedEnd();
          const setEndTimeout = () =>
            batchedRunAtFutureTimeWithPriority(() => setWantedAmperage(() => () => 0), end, false);

          // If already in the timeslot, set buying directly
          if (startTimestamp <= now && now <= end) {
            setWantedAmperage(() => () => scheduleItem().charging_amperage);
            setEndTimeout();
          } else if (startTimestamp > now) {
            // If schedule item starts in the future, set timeout for both start and end
            batchedRunAtFutureTimeWithPriority(
              () => setWantedAmperage(() => () => scheduleItem().charging_amperage),
              startTimestamp,
              true
            );
            setEndTimeout();
          } else {
            // If schedule item has ended, set buying to 0
            setWantedAmperage(() => () => 0);
          }
        });
        return wantedAmperage;
      }
    )
  );

  let hitSOCLimit = false;

  const amperageFromSchedule = createMemo(() => {
    const soc = averageSOC();
    if (soc === undefined) return;
    const { only_buy_below_soc, start_buying_again_below_soc } = config().scheduled_power_buying;
    const limitToUse = hitSOCLimit ? start_buying_again_below_soc : only_buy_below_soc;
    // take the maximum value of all schedule items
    const values = scheduleOutput().map(schedule => schedule()());
    let result = Math.max(...values);
    if (Math.abs(result) === Infinity) {
      result = 0;
    }

    if (soc < limitToUse) {
      hitSOCLimit = false;
      return result;
    } else if (result) {
      // Only allow hitting SOC limit while we're buying power
      hitSOCLimit = true;
    }
    return 0;
  });

  const buyAmpsLess = useShouldBuyAmpsLessToNotBlowFuse(config, amperageFromSchedule);

  const chargingAmperageForBuying = createMemo(() => {
    const fromSchedule = amperageFromSchedule();
    if (!fromSchedule) return fromSchedule;
    return Math.max(0, fromSchedule - buyAmpsLess());
  });

  createEffect(() =>
    log("AC Charging due to scheduled power buying wants to AC charge with", chargingAmperageForBuying(), "ampere(s)")
  );

  return { chargingAmperageForBuying };
}
