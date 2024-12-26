import { Accessor, createMemo } from "solid-js";
import { useFromMqttProvider } from "../mqttValues/MQTTValuesProvider";
import { Config } from "../config";
import { reactiveBatteryVoltage } from "../mqttValues/mqttHelpers";

export function useShouldBuyAmpsLessToNotBlowFuse(
  config: Accessor<Config>,
  currentChargingAmps: Accessor<number | undefined>
) {
  const { mqttValues } = useFromMqttProvider();
  return createMemo(() => {
    const powerR = mqttValues?.["ac_output_active_power_r"]?.value;
    const powerS = mqttValues?.["ac_output_active_power_s"]?.value;
    const powerT = mqttValues?.["ac_output_active_power_t"]?.value;
    const wantToChargeWith = currentChargingAmps();
    const highestPhasePower = Math.max(powerR || 0, powerS || 0, powerT || 0);
    const batteryVoltage = reactiveBatteryVoltage();
    if (
      !batteryVoltage ||
      !wantToChargeWith ||
      wantToChargeWith < config().scheduled_power_buying.enable_subtracting_consumption_above_charging_amperage
    ) {
      return 0;
    }
    // We have to compare with the highest phase power because we're charging with the same power across all phases
    // Round with 500 watts accuracy to not run into our rate limiting so often
    const powerToChargeLessWith = Math.round((highestPhasePower * 3) / 500) * 500;
    const ampsToChargeLessWith = powerToChargeLessWith / batteryVoltage;
    return Math.round(ampsToChargeLessWith);
  });
}
