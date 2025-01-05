import { Accessor, createEffect, createMemo, createSignal, mapArray } from "solid-js";
import { Config } from "../config";
import { log } from "../utilities/logging";
import { batchedRunAtFutureTimeWithPriority } from "../utilities/batchedRunAtFutureTimeWithPriority";
import { calculateChargingAmperage } from "./calculateChargingAmperage";
import { reactiveAcInputVoltageR, reactiveAcInputVoltageS, reactiveAcInputVoltageT } from "../mqttValues/mqttHelpers";

export function useShouldBuyPower({
  config,
  averageSOC,
  assumedParasiticConsumption,
}: {
  config: Accessor<Config>;
  averageSOC: Accessor<number | undefined>;
  assumedParasiticConsumption: Accessor<number>;
}) {
  const scheduleOutput = createMemo(
    mapArray(
      () => Object.keys(config().scheduled_power_buying.schedule),
      startTime => {
        const [wantedPower, setWantedPower] = createSignal<Accessor<number>>(() => 0);
        const scheduleItem = () => config().scheduled_power_buying.schedule[startTime];
        const startTimestamp = +new Date(startTime);
        const memoizedEnd = createMemo(() => +new Date(scheduleItem().end_time));
        const now = +new Date();

        createEffect(() => {
          const end = memoizedEnd();
          const setEndTimeout = () =>
            batchedRunAtFutureTimeWithPriority(() => setWantedPower(() => () => 0), end, false);

          // If already in the timeslot, set buying directly
          if (startTimestamp <= now && now <= end) {
            setWantedPower(() => () => scheduleItem().charging_power);
            setEndTimeout();
          } else if (startTimestamp > now) {
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

  let hitSOCLimit = false;

  const powerFromSchedule = createMemo(() => {
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

  const maxGridAmps = createMemo(() => config().scheduled_power_buying.max_grid_input_amperage);
  const chargingAmperageForBuying = createMemo(() => {
    const power = powerFromSchedule();
    if (!power) return power;
    const voltageR = reactiveAcInputVoltageR();
    const voltageS = reactiveAcInputVoltageS();
    const voltageT = reactiveAcInputVoltageT();
    if (voltageR == undefined || voltageS == undefined || voltageT == undefined) return undefined;
    const lowestVoltage = Math.min(voltageR, voltageS, voltageT);
    const unlimitedGridInAmperage = power / lowestVoltage;
    const limitedGridInAmperage = Math.min(unlimitedGridInAmperage, maxGridAmps());
    const amperageAtBattery = calculateChargingAmperage(limitedGridInAmperage, assumedParasiticConsumption);

    return amperageAtBattery;
  });

  createEffect(() =>
    log("AC Charging due to scheduled power buying wants to AC charge with", chargingAmperageForBuying(), "ampere(s)")
  );

  return { chargingAmperageForBuying };
}
