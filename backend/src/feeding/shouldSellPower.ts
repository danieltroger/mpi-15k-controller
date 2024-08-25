import { Accessor, createEffect, createMemo, createSignal, indexArray, onCleanup } from "solid-js";
import { Config } from "../config";
import { log } from "../utilities/logging";

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
          const setEndTimeout = () => {
            const endTimeout = setTimeout(() => setWantedOutput(() => () => 0), end - now);
            onCleanup(() => {
              console.log("deleting end timeout");
              clearTimeout(endTimeout);
            });
          };

          console.log("effect run for now", now, "start", start, "end", end);

          // If already in the timeslot, set feeding directly
          if (start <= now && now <= end) {
            console.log("In feeding timeslot, starting directly");
            setWantedOutput(() => () => schedule().power_watts);
            setEndTimeout();
          } else if (start > now) {
            // If schedule item starts in the future, set timeout for both start and end
            console.log("scheduling start timer in", start - now, "and end timer in", end - now);
            const startTimeout = setTimeout(() => setWantedOutput(() => () => schedule().power_watts), start - now);
            setEndTimeout();

            onCleanup(() => {
              console.log("deleting start timeout");
              clearTimeout(startTimeout);
            });
          }

          onCleanup(() => {
            console.log("cleanup, setting to 0 ");
            setWantedOutput(() => () => 0);
          });
        });
        return wantedOutput;
      }
    )
  );

  const exportAmountForSelling = createMemo(() => {
    const soc = averageSOC();
    if (soc === undefined) return;
    const onlySellAboveSoc = config().scheduled_power_selling.only_sell_above_soc;
    if (soc > onlySellAboveSoc) {
      // return the maximum value of all schedule items
      const result = Math.max(...scheduleOutput().map(schedule => schedule()()));
      if (Math.abs(result) === Infinity) {
        return 0;
      }
      return result;
    }
    return 0;
  });

  createEffect(() => log("Starting to feed in " + exportAmountForSelling() + "watts due to scheduled power selling"));

  return { exportAmountForSelling };
}
