import { useMQTTValues } from "./useMQTTValues";
import { createEffect } from "solid-js";

export function prematureFloatBugWorkaround(mqttValues: ReturnType<typeof useMQTTValues>) {
  const getVoltage = () => mqttValues.battery_voltage;
  const getCurrent = () => mqttValues.battery_current;
  createEffect(() => {
    console.log("Voltage", getVoltage()?.value, "when:", getVoltage()?.time);
  });
  createEffect(() => {
    console.log("Current", getCurrent()?.value, "when:", getCurrent()?.time);
  });
}
