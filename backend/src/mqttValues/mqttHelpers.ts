import { useFromMqttProvider } from "./MQTTValuesProvider";

// Volts
export function reactiveBatteryVoltage() {
  const { mqttValues } = useFromMqttProvider();
  const value = mqttValues.battery_voltage?.value;
  if (!value) return value;
  return value / 10;
}

// Amperes
export function reactiveBatteryCurrent() {
  const { mqttValues } = useFromMqttProvider();
  const value = mqttValues.battery_current?.value;
  if (!value) return value;
  return value / 10;
}

// Unix timestamp (Date.now())
export function reactiveBatteryCurrentTime() {
  const { mqttValues } = useFromMqttProvider();
  return mqttValues.battery_current?.time;
}

// Unix timestamp (Date.now())
export function reactiveBatteryVoltageTime() {
  const { mqttValues } = useFromMqttProvider();
  return mqttValues.battery_voltage?.time;
}
