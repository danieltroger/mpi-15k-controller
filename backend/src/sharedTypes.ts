export type CurrentBatteryPowerBroadcast = { time: number; value: number };
export type MqttValue = { time: number; value: number };
/** Wire shape of the `elpatronState` ws accessor — whether the water heater element is powered. */
export type ElpatronDisplayState = { heating: boolean | undefined; time: number };

/** One thermometer's entry in the `temperatures` ws record (keyed by device id). */
export type TemperatureReadingBroadcast = {
  value: number;
  time: number;
  thermometer_device_id: string;
  label: string;
};

export type ElpatronMode = "off" | "always_on" | "solar";

/**
 * Legacy configs only carry `enabled`; `mode` wins when present. Shared so the backend switcher,
 * the planner's load model and the frontend card all resolve the three-way mode identically.
 */
export function resolveElpatronMode(elpatronConfig: { mode?: ElpatronMode; enabled: boolean }): ElpatronMode {
  return elpatronConfig.mode ?? (elpatronConfig.enabled ? "solar" : "off");
}

export type MqttValueKey = (typeof mqttValueKeys)[number];

export const mqttValueKeys = [
  "solar_input_power_1",
  "solar_input_power_2",
  "ac_input_active_power_r",
  "ac_input_active_power_s",
  "ac_input_active_power_t",
  "ac_input_total_active_power",
  "ac_output_active_power_r",
  "ac_output_active_power_s",
  "ac_output_active_power_t",
  "ac_output_total_active_power",
  "ac_output_apparent_power_r",
  "ac_output_apparent_power_s",
  "ac_output_apparent_power_t",
  "ac_output_total_apparent_power",
  "ac_output_power_percentage",
  "ac_output_connect_status",
  "solar_input_1_work_status",
  "solar_input_2_work_status",
  "battery_power_direction",
  "dc/ac_power_direction",
  "line_power_direction",
  "solar_input_voltage_1",
  "solar_input_voltage_2",
  "solar_input_current_1",
  "solar_input_current_2",
  "battery_voltage",
  "battery_capacity",
  "battery_current",
  "ac_input_voltage_r",
  "ac_input_voltage_s",
  "ac_input_voltage_t",
  "ac_input_frequency",
  "ac_input_current_r",
  "ac_input_current_s",
  "ac_input_current_t",
  "ac_output_voltage_r",
  "ac_output_voltage_s",
  "ac_output_voltage_t",
  "ac_output_frequency",
  "inner_temperature",
  "component_max_temperature",
  "external_battery_temperature",
  "setting_change_bit",
] as const;
