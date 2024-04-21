import { useMQTTValues } from "./useMQTTValues";
import { get_config_object } from "./config";
import { createEffect, createMemo, untrack } from "solid-js";
import { createStore } from "solid-js/store";

export function useCurrentPower(
  mqttValues: ReturnType<typeof useMQTTValues>,
  [config]: Awaited<ReturnType<typeof get_config_object>>
) {
  const currentPower = createMemo(() => {
    // The voltage is guaranteed by mpp-solar and the inverter to always update before the current
    // Both values update practically at the same time but don't get written to the mqttValues store in a batch
    // Due to the deterministic nature of the updates, we can rely on the voltage being from the same "update situation" as the current every time the current updates
    const current = mqttValues.battery_current as undefined | { time: number; value: number };
    if (!current) return;
    const { value: incomingCurrent, time: amperageTimestamp } = current;
    const voltage = untrack(
      () =>
        mqttValues.battery_voltage && {
          time: mqttValues.battery_voltage?.time,
          value: mqttValues?.battery_voltage?.value as number,
        }
    );
    if (!voltage) {
      // If we for some reason don't have a voltage, make this effect depend on it so we re-execute once we have it
      mqttValues.battery_voltage?.value;
      return;
    }
    const { value: incomingVoltage, time: voltageTimestamp } = voltage;
    const voltageNow = incomingVoltage / 10;
    const currentNow = incomingCurrent / 10;
    const power = voltageNow * currentNow;
    return { value: power, time: Math.min(amperageTimestamp, voltageTimestamp) };
  });
  const haveSeenBatteryFullAt = createMemo(() => {
    const voltage = mqttValues.battery_voltage?.value as undefined | number;
    if (voltage == undefined) return;
    if (voltage / 10 >= config().full_battery_voltage) {
      return mqttValues.battery_voltage?.time;
    }
  });

  const [localPowerHistory, setLocalPowerHistory] = createStore<{ value: number; time: number }[]>([]);

  createEffect(() => {
    const power = currentPower();
    if (!power) return;
    setLocalPowerHistory(
      untrack(() => localPowerHistory.length),
      power
    );
  });

  createEffect(() => {
    const fullWhen = haveSeenBatteryFullAt();
    if (fullWhen) {
      const oldestValue = localPowerHistory[0]?.time;
      if (oldestValue && oldestValue < fullWhen) {
        setLocalPowerHistory(localPowerHistory.filter(({ time }) => time >= fullWhen));
      }
    }
  });

  return { localPowerHistory, currentPower, lastBatterySeenFullSinceProgramStart: haveSeenBatteryFullAt };
}
