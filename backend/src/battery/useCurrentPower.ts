import { get_config_object } from "../config";
import { createMemo, untrack } from "solid-js";
import { useFromMqttProvider } from "../mqttValues/MQTTValuesProvider";
import { reactiveBatteryCurrent, reactiveBatteryVoltage, reactiveBatteryVoltageTime } from "../mqttValues/mqttHelpers";

export function useCurrentPower([config]: Awaited<ReturnType<typeof get_config_object>>) {
  const { mqttValues } = useFromMqttProvider();
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

  const haveSeenBatteryFullAt = createMemo<number | undefined>(prev => {
    const voltage = reactiveBatteryVoltage();
    const current = reactiveBatteryCurrent();
    if (voltage == undefined || current == undefined) return prev;
    if (voltage >= config().full_battery_voltage && current < config().stop_charging_below_current) {
      return reactiveBatteryVoltageTime();
    }
    return prev;
  });

  const haveSeenBatteryEmptyAt = createMemo<number | undefined>(prev => {
    const voltage = reactiveBatteryVoltage();
    if (voltage == undefined) return prev;
    if (voltage <= config().soc_calculations.battery_empty_at) {
      return reactiveBatteryVoltageTime();
    }
    return prev;
  });

  return {
    currentPower,
    lastBatterySeenFullSinceProgramStart: haveSeenBatteryFullAt,
    lastBatterySeenEmptySinceProgramStart: haveSeenBatteryEmptyAt,
  };
}
