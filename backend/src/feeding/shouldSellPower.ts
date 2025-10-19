import { Accessor, createEffect, createMemo, createSignal, mapArray } from "solid-js";
import { logLog } from "../utilities/logging";
import { batchedRunAtFutureTimeWithPriority } from "../utilities/batchedRunAtFutureTimeWithPriority";
import { reactiveBatteryVoltage } from "../mqttValues/mqttHelpers";
import { Config } from "../config/config.types";

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

  let hitLimit = false;

  const exportAmountForSelling = createMemo(() => {
    const soc = averageSOC();
    const voltage = reactiveBatteryVoltage();
    if (soc === undefined || voltage === undefined) return;

    const onlySellAboveSoc = config().scheduled_power_selling.only_sell_above_soc;
    const startSellingAgainAboveSoc = config().scheduled_power_selling.start_selling_again_above_soc;
    const onlySellAboveVoltage = config().scheduled_power_selling.only_sell_above_voltage;
    const startSellingAgainAboveVoltage = config().scheduled_power_selling.start_selling_again_above_voltage;

    const socLimitToUse = hitLimit ? startSellingAgainAboveSoc : onlySellAboveSoc;
    const voltageLimitToUse = hitLimit ? startSellingAgainAboveVoltage : onlySellAboveVoltage;

    // take the maximum value of all schedule items
    const values = scheduleOutput().map(schedule => schedule()());
    let result = Math.max(...values);
    if (Math.abs(result) === Infinity) {
      result = 0;
    }

    // Only sell if we're above BOTH soc and voltage limits
    if (soc > socLimitToUse && voltage > voltageLimitToUse) {
      hitLimit = false;
      return result;
    } else if (result) {
      // Only allow hitting limit while we're feeding in
      hitLimit = true;
    }
    return 0;
  });

  createEffect(() =>
    logLog("Feed in due to scheduled power selling wants to feed in", exportAmountForSelling(), "watts")
  );

  return { exportAmountForSelling };
}
