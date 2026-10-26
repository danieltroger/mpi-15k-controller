/**
 * A decoded HFS answer → the fault record the tracker keeps — pure. The record is filed under the
 * slot that was asked for: this firmware leaves the record's own slot field at 00 in every slot
 * (all nine read 00 on 2026-10-26, while their contents differ), so that field says nothing.
 */
import type { FaultRecordId, InverterFaultRecord, InverterFaultRecordValues } from "./inverterStatus.types.ts";
import type { DecodedFields } from "./pi17Protocol.types.ts";
import { describeInverterFaultCode } from "./inverterFaultCodes.ts";

export function faultRecordOf(
  fields: DecodedFields,
  slot: FaultRecordId,
  decodedAt: number
): InverterFaultRecord | undefined {
  const faultCode = fields.fault_record_fault_code;
  if (typeof faultCode !== "number") return undefined;
  return {
    record_id: slot,
    fault_code: faultCode,
    fault_text: describeInverterFaultCode(faultCode),
    values: faultRecordValuesOf(fields),
    unidentified: UNIDENTIFIED_FIELD_KEYS.map(key => String(fields[key] ?? "")).join(","),
    time: decodedAt,
  };
}

/** Same slot content as before: a re-read of an unchanged slot isn't news */
export function sameFaultRecordContent(first: InverterFaultRecord, second: InverterFaultRecord): boolean {
  return (
    first.fault_code === second.fault_code &&
    first.unidentified === second.unidentified &&
    JSON.stringify(first.values) === JSON.stringify(second.values)
  );
}

/** Where each readable value sits among the decoded HFS fields (pi17FieldTables.ts) */
const VALUE_FIELD_KEYS: Readonly<Record<keyof InverterFaultRecordValues, string>> = {
  ac_input_voltage_r: "fault_record_ac_input_voltage_r",
  ac_input_voltage_s: "fault_record_ac_input_voltage_s",
  ac_input_voltage_t: "fault_record_ac_input_voltage_t",
  ac_input_frequency: "fault_record_ac_input_frequency",
  battery_voltage: "fault_record_battery_voltage",
  ac_output_voltage_s: "fault_record_ac_output_voltage_s",
  ac_output_voltage_t: "fault_record_ac_output_voltage_t",
  ac_output_frequency: "fault_record_ac_output_frequency",
  ac_output_apparent_power_r: "fault_record_ac_output_apparent_power_r",
  ac_output_apparent_power_s: "fault_record_ac_output_apparent_power_s",
  ac_output_apparent_power_t: "fault_record_ac_output_apparent_power_t",
  ac_output_load_percent: "fault_record_ac_output_load_percentage",
  inner_temperature: "fault_record_inner_temperature",
  component_max_temperature: "fault_record_component_max_temperature",
};

/** The tokens no reading fits yet, in protocol order */
const UNIDENTIFIED_FIELD_KEYS: readonly string[] = [
  "fault_record_time",
  "fault_record_work_mode",
  "fault_record_unidentified_4",
  "fault_record_unidentified_5",
  "fault_record_unidentified_6",
  "fault_record_unidentified_12",
  "fault_record_unidentified_13",
  "fault_record_unidentified_23",
  "fault_record_unidentified_24",
];

/** All readable values, or nothing: a record missing one of them is shown by its tokens alone */
function faultRecordValuesOf(fields: DecodedFields): InverterFaultRecordValues | undefined {
  const values: Partial<InverterFaultRecordValues> = {};
  for (const [valueName, fieldKey] of Object.entries(VALUE_FIELD_KEYS) as [keyof InverterFaultRecordValues, string][]) {
    const fieldValue = fields[fieldKey];
    if (typeof fieldValue !== "number") return undefined;
    values[valueName] = fieldValue;
  }
  return values as InverterFaultRecordValues;
}
