/**
 * One line for what a fault record shows about the moment of the fault — pure, type-only imports,
 * so the log (inverterStatusLogText.ts) and the /system card word it the same way.
 */
import type { InverterFaultRecordValues } from "./inverterStatus.types.ts";

export function describeFaultRecordValues(values: InverterFaultRecordValues): string {
  return (
    `grid ${volts(values.ac_input_voltage_r)}/${volts(values.ac_input_voltage_s)}/${volts(values.ac_input_voltage_t)} V ` +
    `at ${values.ac_input_frequency.toFixed(2)} Hz, battery ${volts(values.battery_voltage)} V, ` +
    `output ${volts(values.ac_output_voltage_s)}/${volts(values.ac_output_voltage_t)} V at ${values.ac_output_frequency.toFixed(2)} Hz, ` +
    `${values.ac_output_apparent_power_r}/${values.ac_output_apparent_power_s}/${values.ac_output_apparent_power_t} VA ` +
    `(${values.ac_output_load_percent} % load), inner ${values.inner_temperature} °C, component ${values.component_max_temperature} °C`
  );
}

function volts(value: number): string {
  return value.toFixed(1);
}
