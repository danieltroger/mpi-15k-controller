import { Accessor, createEffect, createMemo, createSignal, mapArray } from "solid-js";
import { Config } from "../config";
import { log } from "../utilities/logging";
import { batchedRunAtFutureTimeWithPriority } from "../utilities/batchedRunAtFutureTimeWithPriority";
import { calculateChargingAmperage } from "./calculateChargingAmperage";
import { reactiveAcInputVoltageR, reactiveAcInputVoltageS, reactiveAcInputVoltageT } from "../mqttValues/mqttHelpers";
import { useFromMqttProvider } from "../mqttValues/MQTTValuesProvider";

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
  // How many amps the set power wants us to CHARGE WITH at the grid input (~230v), given the current grid value and max limit defined in the config
  const wantedGridAmperage = createMemo(() => {
    const power = powerFromSchedule();
    if (!power) return power;
    const voltageR = reactiveAcInputVoltageR();
    const voltageS = reactiveAcInputVoltageS();
    const voltageT = reactiveAcInputVoltageT();
    if (voltageR == undefined || voltageS == undefined || voltageT == undefined) return undefined;
    const lowestVoltage = Math.min(voltageR, voltageS, voltageT);
    const unlimitedGridInAmperage = power / 3 / lowestVoltage;
    const limitedGridInAmperage = Math.min(unlimitedGridInAmperage, maxGridAmps());
    return limitedGridInAmperage;
  });

  // How many amperes we can charge with AT THE BATTERY (50v), given the current grid phase voltages, house power consumption and battery voltage, to not exceed the grid amperage limit
  const chargingAmperageForBuyingUnrounded = createMemo(() => {
    const limitedGridInAmperage = wantedGridAmperage();
    if (!limitedGridInAmperage) return limitedGridInAmperage;
    const amperageAtBattery = calculateChargingAmperage(limitedGridInAmperage, assumedParasiticConsumption);
    return amperageAtBattery;
  });

  // Round to 10-ampere accuracy for now to avoid running into rate-limiting too much
  const chargingAmperageForBuying = createMemo(() => {
    const amperage = chargingAmperageForBuyingUnrounded();
    if (!amperage) return amperage;
    const roundedAmperage = Math.round(amperage / 10) * 10;
    // Hardcoded because our inverter can AC charge with 300A max
    return Math.max(Math.min(roundedAmperage, 300), 0);
  });

  createEffect(() =>
    log("AC Charging due to scheduled power buying wants to AC charge with", chargingAmperageForBuying(), "ampere(s)")
  );

  useLogGridAmperageEvaluation({ wantedGridAmperage, chargingAmperageForBuying });

  return { chargingAmperageForBuying };
}

export function useLogGridAmperageEvaluation({
  wantedGridAmperage,
  chargingAmperageForBuying,
}: {
  wantedGridAmperage: Accessor<number | undefined>;
  chargingAmperageForBuying: Accessor<number | undefined>;
}) {
  const { mqttClient } = useFromMqttProvider();
  const table = "input_amp_experiment";

  createEffect(() => {
    const client = mqttClient();
    if (!client) return;

    createEffect(() => {
      const value = wantedGridAmperage();
      if (value == undefined) return;
      const influx_entry = `${table} wanted_grid_amperage=${value}`;
      if (client.connected) {
        client.publish(table, influx_entry).catch(e => {
          log("Couldn't publish message", influx_entry, e);
        });
      }
    });

    createEffect(() => {
      const value = chargingAmperageForBuying();
      if (value == undefined) return;
      const influx_entry = `${table} charging_amperage_for_buying=${value}`;
      if (client.connected) {
        client.publish(table, influx_entry).catch(e => {
          log("Couldn't publish message", influx_entry, e);
        });
      }
    });
  });
}
