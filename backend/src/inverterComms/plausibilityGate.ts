/**
 * Last line of defence between the serial decoder and every consumer — pure, no I/O. A round with
 * any physically impossible value is dropped whole, before it reaches the stores (SOC anchor
 * detection, alerting, the feed/buy loops) or the MQTT → InfluxDB feed.
 *
 * Frame attribution (pi17ResponseShapes.ts) is what stops the 2026-10-25 failure, where a PS frame
 * decoded as GS published battery_voltage −30.9 V and an "empty" anchor followed. This gate exists
 * for whatever gets past it anyway — a firmware quirk, a CRC collision, a future decoding bug —
 * because a single such value can re-anchor SOC or page someone at night. The bounds are wide
 * enough that no genuine reading of this 16S LiFePO4 / 15 kW / 3-phase 230 V system leaves them
 * (a grid outage reads 0 V / 0 Hz, which stays allowed).
 */
import type { DecodedFields } from "./pi17Protocol.types.ts";
import { influxFieldName, PI17_QUERY_RESPONSE_FIELDS } from "./pi17FieldTables.ts";
import type { InclusiveRange } from "./pi17ResponseShapes.ts";

export function implausibleFieldsIn(fields: DecodedFields): string[] {
  const problems: string[] = [];
  for (const [name, value] of Object.entries(fields)) {
    if (typeof value === "number") {
      const plausibleRanges = PLAUSIBLE_NUMERIC_RANGES[name];
      if (
        plausibleRanges &&
        !plausibleRanges.some(plausibleRange => value >= plausibleRange.min && value <= plausibleRange.max)
      ) {
        problems.push(`${name}=${value} outside ${plausibleRanges.map(describe).join(" or ")}`);
      }
      continue;
    }
    if (OPTION_FIELD_NAMES.has(name) && !OPTIONS_ALLOWED_INVALID.has(name) && isInvalidOption(value)) {
      problems.push(`${name}=${JSON.stringify(value)} is not a valid option`);
    }
  }
  return problems;
}

const inclusiveRange = (min: number, max: number): InclusiveRange => ({ min, max });
/** Grid absent (outage / generator off) reads exactly 0 — anything else must be a real mains frequency */
const FREQUENCY_OR_ABSENT = [inclusiveRange(0, 0), inclusiveRange(45, 55)];
const MAINS_VOLTAGE = [inclusiveRange(0, 300)];
const PHASE_CURRENT = [inclusiveRange(-100, 100)];
const PHASE_POWER = [inclusiveRange(-20_000, 20_000)];
const TOTAL_POWER = [inclusiveRange(-60_000, 60_000)];
const TEMPERATURE = [inclusiveRange(-40, 150)];
/** 16S LiFePO4: 2.5 V/cell = 40 V is below the BMS cut-off, 3.875 V/cell = 62 V above any charge setting */
const PACK_VOLTAGE = [inclusiveRange(40, 62)];
const FAULT_CODE = [inclusiveRange(0, 99)];
const FAULT_RECORD_SLOT = [inclusiveRange(0, 8)];

/**
 * Every numeric GS/PS field, every settings field a control loop consumes and every numeric status
 * field an alert reads (the selftest enforces the coverage). Settings fields nothing reads are
 * deliberately not gated.
 */
export const PLAUSIBLE_NUMERIC_RANGES: Readonly<Record<string, readonly InclusiveRange[]>> = {
  // GS
  solar_input_voltage_1: [inclusiveRange(0, 1000)],
  solar_input_voltage_2: [inclusiveRange(0, 1000)],
  solar_input_current_1: [inclusiveRange(0, 60)],
  solar_input_current_2: [inclusiveRange(0, 60)],
  battery_voltage: PACK_VOLTAGE,
  battery_capacity: [inclusiveRange(0, 100)],
  // The inverter's charge limit is 300 A; ±400 A leaves headroom for its current sensor's overshoot
  battery_current: [inclusiveRange(-400, 400)],
  ac_input_voltage_r: MAINS_VOLTAGE,
  ac_input_voltage_s: MAINS_VOLTAGE,
  ac_input_voltage_t: MAINS_VOLTAGE,
  ac_input_frequency: FREQUENCY_OR_ABSENT,
  ac_input_current_r: PHASE_CURRENT,
  ac_input_current_s: PHASE_CURRENT,
  ac_input_current_t: PHASE_CURRENT,
  ac_output_voltage_r: MAINS_VOLTAGE,
  ac_output_voltage_s: MAINS_VOLTAGE,
  ac_output_voltage_t: MAINS_VOLTAGE,
  ac_output_frequency: FREQUENCY_OR_ABSENT,
  ac_output_current_r: PHASE_CURRENT,
  ac_output_current_s: PHASE_CURRENT,
  ac_output_current_t: PHASE_CURRENT,
  inner_temperature: TEMPERATURE,
  component_max_temperature: TEMPERATURE,
  external_battery_temperature: TEMPERATURE,
  // PS (checked after fixMpiAcInputFields has repaired the firmware's garbage totals)
  solar_input_power_1: [inclusiveRange(0, 20_000)],
  solar_input_power_2: [inclusiveRange(0, 20_000)],
  battery_power: [inclusiveRange(-30_000, 30_000)],
  ac_input_active_power_r: PHASE_POWER,
  ac_input_active_power_s: PHASE_POWER,
  ac_input_active_power_t: PHASE_POWER,
  ac_input_total_active_power: TOTAL_POWER,
  ac_output_active_power_r: PHASE_POWER,
  ac_output_active_power_s: PHASE_POWER,
  ac_output_active_power_t: PHASE_POWER,
  ac_output_total_active_power: TOTAL_POWER,
  ac_output_apparent_power_r: [inclusiveRange(0, 20_000)],
  ac_output_apparent_power_s: [inclusiveRange(0, 20_000)],
  ac_output_apparent_power_t: [inclusiveRange(0, 20_000)],
  ac_output_total_apparent_power: [inclusiveRange(0, 60_000)],
  ac_output_power_percentage: [inclusiveRange(0, 300)],
  // Settings readbacks that drive writes (feedWhenNoSolar, the voltage workaround, buying)
  maximum_feeding_grid_power: [inclusiveRange(0, 15_000)],
  "battery_constant_charge_voltage(c.v.)": PACK_VOLTAGE,
  battery_floating_charge_voltage: PACK_VOLTAGE,
  "max._ac_charging_current": [inclusiveRange(0, 400)],
  battery_maximum_charge_current: [inclusiveRange(0, 400)],
  // Status (CFS / HFS): two-digit fault codes and the nine flash slots 0–8. A false code would
  // page "new fault" (P2) or name the wrong fault in the fault-mode P1. MOD and the WS flags are
  // keyed/option fields, gated by the invalid-option check below.
  latest_fault_code: FAULT_CODE,
  latest_fault_record_id: FAULT_RECORD_SLOT,
  fault_record_id: FAULT_RECORD_SLOT,
  fault_record_fault_code: FAULT_CODE,
};

/**
 * The live firmware really sends setting_change_bit=4 now and then (the retired daemon's schema
 * carries "Invalid option: 4"), so that one stays publishable for Influx continuity; it gates nothing.
 */
const OPTIONS_ALLOWED_INVALID = new Set(["setting_change_bit"]);

/** Field names are unique across the decode tables, so one set covers every command */
const OPTION_FIELD_NAMES: ReadonlySet<string> = new Set(
  Object.values(PI17_QUERY_RESPONSE_FIELDS).flatMap(specs =>
    specs
      .filter(spec => spec.reading.kind === "option" || spec.reading.kind === "str_keyed")
      .map(spec => influxFieldName(spec.name))
  )
);

function isInvalidOption(value: string): boolean {
  // The decoder's renderings of an out-of-table selector (mpp-solar's exact wording)
  return value.startsWith("Invalid option:") || value.startsWith("Unknown key:");
}

function describe({ min, max }: InclusiveRange): string {
  return min === max ? `${min}` : `[${min}, ${max}]`;
}
