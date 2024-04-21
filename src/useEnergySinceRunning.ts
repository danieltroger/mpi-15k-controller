import { useMQTTValues } from "./useMQTTValues";
import { get_config_object } from "./config";
import { createEffect, createMemo, getOwner, on, runWithOwner, untrack } from "solid-js";
import { log } from "./logging";

export function useEnergySinceRunning(
  mqttValues: ReturnType<typeof useMQTTValues>,
  configSignal: Awaited<ReturnType<typeof get_config_object>>
) {
  const power = createMemo(() => {
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

  return power;
}
