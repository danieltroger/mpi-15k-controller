import { Accessor, createEffect, createMemo, createSignal, mapArray } from "solid-js";
import { Config } from "../config";
import { log } from "../utilities/logging";
import { batchedRunAtFutureTimeWithPriority } from "../utilities/batchedRunAtFutureTimeWithPriority";

export function shouldSellPower(config: Accessor<Config>, averageSOC: Accessor<number | undefined>) {
  const scheduleOutput = createMemo(
    mapArray(
      () => Object.keys(config().scheduled_power_selling.schedule),
      startTime => {
        const [wantedOutput, setWantedOutput] = createSignal<Accessor<number>>(() => 0);
        const scheduleItem = () => config().scheduled_power_selling.schedule[startTime];
        const startTimestamp = +new Date(startTime);
        const memoizedEnd = createMemo(() => +new Date(scheduleItem().end_time));
        const now = +new Date();

        createEffect(() => {
          const end = memoizedEnd();
          const setEndTimeout = () =>
            batchedRunAtFutureTimeWithPriority(() => setWantedOutput(() => () => 0), end, false);

          // If already in the timeslot, set feeding directly
          if (startTimestamp <= now && now <= end) {
            setWantedOutput(() => () => scheduleItem().power_watts);
            setEndTimeout();
          } else if (startTimestamp > now) {
            // If schedule item starts in the future, set timeout for both start and end
            batchedRunAtFutureTimeWithPriority(
              () => setWantedOutput(() => () => scheduleItem().power_watts),
              startTimestamp,
              true
            );
            setEndTimeout();
          } else {
            // If schedule item has ended, set feeding to 0
            setWantedOutput(() => () => 0);
          }
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
    // take the maximum value of all schedule items
    const values = scheduleOutput().map(schedule => schedule()());
    let result = Math.max(...values);
    if (Math.abs(result) === Infinity) {
      result = 0;
    }

    if (soc > limitToUse) {
      hitSOCLimit = false;
      return result;
    } else if (result) {
      // Only allow hitting SOC limit while we're feeding in
      hitSOCLimit = true;
    }
    return 0;
  });

  createEffect(() => log("Feed in due to scheduled power selling wants to feed in", exportAmountForSelling(), "watts"));

  return { exportAmountForSelling };
}
