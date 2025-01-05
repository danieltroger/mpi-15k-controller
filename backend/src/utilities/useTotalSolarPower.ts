import { useFromMqttProvider } from "../mqttValues/MQTTValuesProvider";

export function useTotalSolarPower() {
  const { mqttValues } = useFromMqttProvider();
  const array1 = mqttValues?.["solar_input_power_1"]?.value;
  const array2 = mqttValues?.["solar_input_power_2"]?.value;
  if (array1 == undefined && array2 == undefined) return undefined;
  return (array1 || 0) + (array2 || 0);
}
