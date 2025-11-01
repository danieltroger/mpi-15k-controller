import { z } from "zod";

// 1. Define the Zod schema for raw mqtt values
export const rawMQTTValuesSchema = z.object({
  solar_input_power_1: z.number(),
  solar_input_power_2: z.number(),
  ac_input_active_power_r: z.number(),
  ac_input_active_power_s: z.number(),
  ac_input_active_power_t: z.number(),
  ac_input_total_active_power: z.number(),
  ac_output_active_power_r: z.number(),
  ac_output_active_power_s: z.number(),
  ac_output_active_power_t: z.number(),
  ac_output_total_active_power: z.number(),
  ac_output_apparent_power_r: z.number(),
  ac_output_apparent_power_s: z.number(),
  ac_output_current_r: z.number(),
  ac_output_current_s: z.number(),
  ac_output_current_t: z.number(),
  ac_output_apparent_power_t: z.number(),
  ac_output_total_apparent_power: z.number(),
  ac_output_power_percentage: z.number(),
  // I made up the "Disconnected" value here, but it probably? exists
  ac_output_connect_status: z.enum(["Connected", "Disconnected"]),
  solar_input_1_work_status: z.enum(["Working", "Idle"]),
  solar_input_2_work_status: z.enum(["Working", "Idle"]),
  battery_power_direction: z.enum(["Charging", "Discharging", "Idle"]),
  "dc/ac_power_direction": z.enum(["DC to AC", "AC to DC", "Idle"]),
  line_power_direction: z.enum(["Output", "Idle", "Input"]),
  solar_input_voltage_1: z.number(),
  solar_input_voltage_2: z.number(),
  solar_input_current_1: z.number(),
  solar_input_current_2: z.number(),
  battery_voltage: z.number(),
  battery_capacity: z.number(),
  currentBatteryPower: z.number(),
  battery_current: z.number(),
  ac_input_voltage_r: z.number(),
  ac_input_voltage_s: z.number(),
  ac_input_voltage_t: z.number(),
  ac_input_frequency: z.number(),
  ac_input_current_r: z.number(),
  ac_input_current_s: z.number(),
  ac_input_current_t: z.number(),
  ac_output_voltage_r: z.number(),
  ac_output_voltage_s: z.number(),
  ac_output_voltage_t: z.number(),
  ac_output_frequency: z.number(),
  inner_temperature: z.number(),
  component_max_temperature: z.number(),
  external_battery_temperature: z.number(),
  setting_change_bit: z.enum(["No setting change", "Settings changed - please refresh"]),
  validity_check: z.enum(["Error: CRC error P17"]),
  error: z.string(),
});

// 2. Infer the TS type from this schema
export type RawMQTTValues = z.infer<typeof rawMQTTValuesSchema>;

// 3. Validate a single key by creating a new Zod object with just that key
export function validateMessage<K extends keyof RawMQTTValues>(key: K, value: unknown) {
  // Create a sub-schema for just the one key
  const schemaEntry = rawMQTTValuesSchema.shape[key];

  if (!schemaEntry) {
    throw new Error(`Unknown key for validation: ${JSON.stringify(key)}: ${JSON.stringify(value)}`);
  }

  const singleFieldSchema = z.object({
    [key]: schemaEntry,
  });
  // parse() will throw a ZodError if invalid
  singleFieldSchema.parse({ [key]: value });
}
