import { useMQTTValues } from "../mqttValues/useMQTTValues";

export const totalSolarPower = (mqttValues: ReturnType<typeof useMQTTValues>["mqttValues"]) => {
  const array1 = mqttValues?.["solar_input_power_1"]?.value as number | undefined;
  const array2 = mqttValues?.["solar_input_power_2"]?.value as number | undefined;
  if (array1 == undefined && array2 == undefined) return undefined;
  return (array1 || 0) + (array2 || 0);
};
