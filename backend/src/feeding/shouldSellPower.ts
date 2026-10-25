import { type Accessor, createEffect, createMemo, createSignal, mapArray, untrack } from "solid-js";
import { logLog, errorLog } from "../utilities/logging.ts";
import { batchedRunAtFutureTimeWithPriority } from "../utilities/batchedRunAtFutureTimeWithPriority.ts";
import { reactiveBatteryVoltage } from "../mqttValues/mqttHelpers.ts";
import { useBatteryValuesProvider } from "../battery/BatteryValuesProvider.ts";
import type { Config } from "../config/config.types.ts";
import { decideSellExport } from "./sellExportDecision.ts";
import { useOverheatSellStop } from "./useOverheatSellStop.ts";

export function shouldSellPower(config: Accessor<Config>) {
  const { clampedSocAh } = useBatteryValuesProvider();
  const overheatSellStop = useOverheatSellStop(config);
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

          if (end <= startTimestamp) {
            errorLog(
              "Scheduled power selling item has end_time before or equal to start_time - skipping (likely a DST timezone issue)",
              startTime,
              untrack(scheduleItem)
            );
            setWantedOutput(() => () => 0);
            return;
          }

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
    const soc = clampedSocAh();
    const voltage = reactiveBatteryVoltage();
    if (soc === undefined || voltage === undefined) return;

    const decision = decideSellExport({
      ...config().scheduled_power_selling,
      scheduledWattsPerWindow: scheduleOutput().map(schedule => schedule()()),
      soc,
      voltage,
      hitLimit,
      sellingStoppedForOverheat: overheatSellStop().sellingStopped,
    });
    hitLimit = decision.hitLimit;
    return decision.exportWatts;
  });

  createEffect(() =>
    logLog("Feed in due to scheduled power selling wants to feed in", exportAmountForSelling(), "watts")
  );

  return { exportAmountForSelling, overheatSellStop };
}
