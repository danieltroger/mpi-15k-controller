import { Accessor, createMemo } from "solid-js";
import { useFromMqttProvider } from "../utilities/MQTTValuesProvider";
import { Config } from "../config";

export function useShouldBuyAmpsLessToNotBlowFuse(
  config: Accessor<Config>,
  currentChargingAmps: Accessor<number | undefined>
) {
  const { mqttValues } = useFromMqttProvider();
  return createMemo(() => {
    const powerR = mqttValues?.["ac_output_active_power_r"]?.value as number | undefined;
    const powerS = mqttValues?.["ac_output_active_power_s"]?.value as number | undefined;
    const powerT = mqttValues?.["ac_output_active_power_t"]?.value as number | undefined;
    const wantToChargeWith = currentChargingAmps();
    const highestPhasePower = Math.max(powerR || 0, powerS || 0, powerT || 0);
    const batteryVoltage = mqttValues["battery_voltage"]?.value as number | undefined;
    if (
      !batteryVoltage ||
      !wantToChargeWith ||
      wantToChargeWith < config().scheduled_power_buying.enable_subtracting_consumption_above_charging_amperage
    ) {
      return 0;
    }
    // We have to compare with the highest phase power because we're charging with the same power across all phases
    // Round with 100 watts accuracy
    const powerToChargeLessWith = Math.floor((highestPhasePower * 3) / 100) * 100;
    const ampsToChargeLessWith = powerToChargeLessWith / batteryVoltage;
    return ampsToChargeLessWith;
  });
}
