import { useMQTTValues } from "./useMQTTValues";
import { get_config_object } from "./config";
import { createEffect, createMemo, createSignal, untrack } from "solid-js";

export function useCurrentPower(
  mqttValues: ReturnType<typeof useMQTTValues>["mqttValues"],
  [config]: Awaited<ReturnType<typeof get_config_object>>
) {
  const currentPower = createMemo(() => {
    // The voltage is guaranteed by mpp-solar and the inverter to always update before the current
    // Both values update practically at the same time but don't get written to the mqttValues store in a batch
    // Due to the deterministic nature of the updates, we can rely on the voltage being from the same "update situation" as the current every time the current updates
    const voltage = mqttValues.battery_voltage as undefined | { time: number; value: number };
    if (!voltage) return;
    const { value: incomingVoltage, time: voltageTimestamp } = voltage;
    const current = untrack(
      () =>
        mqttValues.battery_current && {
          time: mqttValues.battery_current?.time,
          value: mqttValues?.battery_current?.value as number,
        }
    );
    if (!current) {
      // If we for some reason don't have a voltage, make this effect depend on it so we re-execute once we have it
      mqttValues.battery_current?.value;
      return;
    }
    const { value: incomingCurrent, time: currentTimestamp } = current;
    const voltageNow = incomingVoltage / 10;
    const currentNow = incomingCurrent / 10;
    const power = voltageNow * currentNow;
    return { value: power, time: Math.min(currentTimestamp, voltageTimestamp) };
  });
  const haveSeenBatteryFullAt = createMemo<number | undefined>(prev => {
    const voltage = mqttValues.battery_voltage?.value as undefined | number;
    const current = mqttValues.battery_current?.value as undefined | number;
    if (voltage == undefined || current == undefined) return prev;
    if (voltage / 10 >= config().full_battery_voltage && current / 10 < config().stop_charging_below_current) {
      return mqttValues.battery_voltage!.time;
    }
    return prev;
  });

  const haveSeenBatteryEmptyAt = createMemo<number | undefined>(prev => {
    const voltage = mqttValues.battery_voltage?.value as undefined | number;
    if (voltage == undefined) return prev;
    if (voltage / 10 <= config().soc_calculations.battery_empty_at) {
      return mqttValues.battery_voltage!.time;
    }
    return prev;
  });

  // Do not use a store since the place reading it would be depending on thousands/millions of signals which uses tons of memory and slows down the program
  const [localPowerHistory, setLocalPowerHistory] = createSignal<{ value: number; time: number }[]>([], {
    equals: false,
  });

  createEffect(() => {
    const power = currentPower();
    if (!power) return;
    setLocalPowerHistory(prev => {
      prev.push(power);
      return prev;
    });
  });

  createEffect(() => {
    const fullWhen = haveSeenBatteryFullAt();
    const emptyWhen = haveSeenBatteryEmptyAt();
    const earliestValueWeNeedToKeep = Math.min(fullWhen || Infinity, emptyWhen || Infinity);
    if (earliestValueWeNeedToKeep !== Infinity) {
      const oldestValue = localPowerHistory()[0]?.time;
      if (oldestValue && oldestValue < earliestValueWeNeedToKeep) {
        setLocalPowerHistory(localPowerHistory().filter(({ time }) => time >= earliestValueWeNeedToKeep));
      }
    }
  });

  return {
    localPowerHistory,
    currentPower,
    lastBatterySeenFullSinceProgramStart: haveSeenBatteryFullAt,
    lastBatterySeenEmptySinceProgramStart: haveSeenBatteryEmptyAt,
  };
}
