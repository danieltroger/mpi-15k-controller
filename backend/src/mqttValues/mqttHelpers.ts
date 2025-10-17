import { useFromMqttProvider } from "./MQTTValuesProvider";

// Volts
export function reactiveBatteryVoltage() {
  const { mqttValues } = useFromMqttProvider();
  return mqttValues.battery_voltage?.value;
}

// Amperes
export function reactiveBatteryCurrent() {
  const { mqttValues } = useFromMqttProvider();
  return mqttValues.battery_current?.value;
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

export function reactiveAcInputVoltageR() {
  const { mqttValues } = useFromMqttProvider();
  return  mqttValues.ac_input_voltage_r?.value;
}

export function reactiveAcInputVoltageS() {
  const { mqttValues } = useFromMqttProvider();
  return mqttValues.ac_input_voltage_s?.value;
}

export function reactiveAcInputVoltageT() {
  const { mqttValues } = useFromMqttProvider();
  return mqttValues.ac_input_voltage_t?.value;
}
