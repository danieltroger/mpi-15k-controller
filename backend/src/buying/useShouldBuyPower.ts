import { Accessor, createEffect, createMemo, createSignal, mapArray } from "solid-js";
import { logLog } from "../utilities/logging";
import { batchedRunAtFutureTimeWithPriority } from "../utilities/batchedRunAtFutureTimeWithPriority";
import { calculateChargingAmperage } from "./calculateChargingAmperage";
import { reactiveBatteryVoltage } from "../mqttValues/mqttHelpers";
import { useFromMqttProvider } from "../mqttValues/MQTTValuesProvider";
import { Config } from "../config/config.types";

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

  // Max amperage we can charge at battery (~50v) without blowing the fuse to the grid
  const maxBatteryChargingAmperage = createMemo(() =>
    calculateChargingAmperage(maxGridAmps(), assumedParasiticConsumption)
  );

  // Charging amperage at the battery (at ~50v)
  const chargingAmperageForBuyingUnlimited = createMemo(() => {
    const userSpecifiedPower = powerFromSchedule();
    if (!userSpecifiedPower) return userSpecifiedPower;
    const batteryVoltage = reactiveBatteryVoltage();
    if (batteryVoltage == undefined) return undefined;
    const unlimitedAmperage = userSpecifiedPower / batteryVoltage;
    const maxAmperage = maxBatteryChargingAmperage();
    // Limit to hardcoded 50A so we're still charging a bit if this happens and so we can diagnose this case, because we have some bug that periodically makes this memo return undefined when it shouldn't
    if (maxAmperage == undefined) return Math.min(unlimitedAmperage, 50);
    return Math.min(unlimitedAmperage, maxAmperage);
  });

  // Round to 10-ampere accuracy for now to avoid running into rate-limiting too much
  const chargingAmperageForBuying = createMemo(() => {
    const amperage = chargingAmperageForBuyingUnlimited();
    if (!amperage) return amperage;
    // Hardcoded because our inverter can AC charge with 300A max
    return Math.max(Math.min(Math.round(amperage), 300), 0);
  });

  createEffect(() =>
    logLog(
      "AC Charging due to scheduled power buying wants to AC charge with",
      chargingAmperageForBuying(),
      "ampere(s)"
    )
  );

  useLogGridAmperageEvaluation({ maxBatteryChargingAmperage, chargingAmperageForBuying });

  return { chargingAmperageForBuying };
}

export function useLogGridAmperageEvaluation({
  maxBatteryChargingAmperage,
  chargingAmperageForBuying,
}: {
  maxBatteryChargingAmperage: Accessor<number | undefined>;
  chargingAmperageForBuying: Accessor<number | undefined>;
}) {
  const { mqttClient } = useFromMqttProvider();
  const table = "input_amp_experiment";

  createEffect(() => {
    const client = mqttClient();
    if (!client) return;

    createEffect(() => {
      const value = maxBatteryChargingAmperage();
      if (value == undefined) return;
      const influx_entry = `${table} max_battery_charging_amperage=${value}`;
      if (client.connected) {
        client.publish(table, influx_entry).catch(e => {
          logLog("Couldn't publish message", influx_entry, e);
        });
      }
    });

    createEffect(() => {
      const value = chargingAmperageForBuying();
      if (value == undefined) return;
      const influx_entry = `${table} charging_amperage_for_buying=${value}`;
      if (client.connected) {
        client.publish(table, influx_entry).catch(e => {
          logLog("Couldn't publish message", influx_entry, e);
        });
      }
    });
  });
}
