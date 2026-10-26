/**
 * PI17 response field tables, ported verbatim from the repo owner's mpp-solar fork (pi17.py) —
 * except the status queries CFS/WS/HFS, which the fork lacks: CFS and WS follow the official 2022
 * PI17 spec, checked against this inverter's answers in the WiFi datalogger's raw uploads
 * (2026-10); HFS follows the layout inferred from this inverter's own records (see its table).
 * The human-readable names are load-bearing: influxFieldName() derives from them the exact field
 * names mpp-solar has always published to MQTT/InfluxDB (e.g. "Solar input voltage 1" →
 * solar_input_voltage_1), so Influx series and Grafana dashboards continue seamlessly. Do not
 * "fix" typos like "(C.V.)" or "Max. AC charging current" — the derived names are the wire format.
 *
 * Deliberately not implemented: the energy-history queries ED/EM/EY/EH. They use mpp-solar's
 * QUERYEN framing — `^P{len:03}{CMD}` where len = command length + 4, followed by a 3-digit
 * decimal ASCII-sum checksum of everything before it — unlike every command below, which carries
 * no checksum at all. The backend never uses them.
 */
import type { Pi17FieldReading, Pi17FieldSpec, Pi17QueryCommandName } from "./pi17Protocol.types.ts";
import type { InverterWorkingModeCode } from "./inverterStatus.types.ts";

/** "Solar input voltage 1" → "solar_input_voltage_1" — mpp-solar's influx2_mqtt naming, byte-exact. */
export function influxFieldName(humanReadableName: string): string {
  return humanReadableName.replaceAll(" ", "_").toLowerCase();
}

const INT: Pi17FieldReading = { kind: "int", divisor: 1 };
const INT_TENTHS: Pi17FieldReading = { kind: "int", divisor: 10 };
const INT_HUNDREDTHS: Pi17FieldReading = { kind: "int", divisor: 100 };
const STRING: Pi17FieldReading = { kind: "string" };
const ENABLED_DISABLED: Pi17FieldReading = { kind: "option", options: ["disabled", "enabled"] };
const WARNING_FLAG: Pi17FieldReading = { kind: "option", options: ["inactive", "active"] };

/** MOD's answer codes in mpp-solar's wording (the status tracker maps the text back to its code) */
export const WORKING_MODE_TEXT_BY_CODE: Readonly<Record<InverterWorkingModeCode, string>> = {
  "00": "Power on mode",
  "01": "Standby mode",
  "02": "Bypass mode",
  "03": "Battery mode",
  "04": "Fault mode",
  "05": "Hybrid mode (Line mode, Grid mode)",
  "06": "Charge mode",
};

function field(name: string, reading: Pi17FieldReading, unit: string): Pi17FieldSpec {
  return { name, reading, unit };
}

export const PI17_QUERY_RESPONSE_FIELDS: Readonly<Record<Pi17QueryCommandName, readonly Pi17FieldSpec[]>> = {
  GS: [
    field("Solar input voltage 1", INT_TENTHS, "V"),
    field("Solar input voltage 2", INT_TENTHS, "V"),
    field("Solar input current 1", INT_HUNDREDTHS, "A"),
    field("Solar input current 2", INT_HUNDREDTHS, "A"),
    field("Battery voltage", INT_TENTHS, "V"),
    field("Battery capacity", INT, "%"),
    field("Battery current", INT_TENTHS, "A"),
    field("AC input voltage R", INT_TENTHS, "V"),
    field("AC input voltage S", INT_TENTHS, "V"),
    field("AC input voltage T", INT_TENTHS, "V"),
    field("AC input frequency", INT_HUNDREDTHS, "Hz"),
    field("AC input current R", INT_TENTHS, "A"),
    field("AC input current S", INT_TENTHS, "A"),
    field("AC input current T", INT_TENTHS, "A"),
    field("AC output voltage R", INT_TENTHS, "V"),
    field("AC output voltage S", INT_TENTHS, "V"),
    field("AC output voltage T", INT_TENTHS, "V"),
    field("AC output frequency", INT_HUNDREDTHS, "Hz"),
    field("AC output current R", INT_TENTHS, "A"),
    field("AC output current S", INT_TENTHS, "A"),
    field("AC output current T", INT_TENTHS, "A"),
    field("Inner temperature", INT, "°C"),
    field("Component max temperature", INT, "°C"),
    field("External Battery temperature", INT, "°C"),
    field(
      "Setting change bit",
      { kind: "option", options: ["No setting change", "Settings changed - please refresh"] },
      ""
    ),
  ],
  PS: [
    field("Solar input power 1", INT, "W"),
    field("Solar input power 2", INT, "W"),
    // Sent empty by the MPI 15K firmware in every live capture — decoding skips empty tokens
    field("Battery power", INT, "W"),
    field("AC input active power R", INT, "W"),
    field("AC input active power S", INT, "W"),
    field("AC input active power T", INT, "W"),
    field("AC input total active power", INT, "W"),
    field("AC output active power R", INT, "W"),
    field("AC output active power S", INT, "W"),
    field("AC output active power T", INT, "W"),
    field("AC output total active power", INT, "W"),
    field("AC output apparent power R", INT, "VA"),
    field("AC output apparent power S", INT, "VA"),
    field("AC output apparent power T", INT, "VA"),
    field("AC output total apparent power", INT, "VA"),
    field("AC output power percentage", INT, "%"),
    field("AC output connect status", { kind: "option", options: ["Disconnected", "Connected"] }, ""),
    field("Solar input 1 work status", { kind: "option", options: ["Idle", "Working"] }, ""),
    field("Solar input 2 work status", { kind: "option", options: ["Idle", "Working"] }, ""),
    field("Battery power direction", { kind: "option", options: ["Idle", "Charging", "Discharging"] }, ""),
    field("DC/AC power direction", { kind: "option", options: ["Idle", "AC to DC", "DC to AC"] }, ""),
    field("Line power direction", { kind: "option", options: ["Idle", "Input", "Output"] }, ""),
  ],
  BATS: [
    field("Battery maximum charge current", INT_TENTHS, "A"),
    field("Battery constant charge voltage(C.V.)", INT_TENTHS, "V"),
    field("Battery floating charge voltage", INT_TENTHS, "V"),
    field("Battery stop charger current level in floating charging", INT_TENTHS, "A"),
    field("Keep charged time of battery catch stopped charging current level", INT, "Minutes"),
    field("Battery voltage of recover to charge when battery stop charger in floating charging", INT_TENTHS, "V"),
    field("Battery under voltage", INT_TENTHS, "V"),
    field("Battery under voltage release", INT_TENTHS, "V"),
    field("Battery weak voltage in hybrid mode", INT_TENTHS, "V"),
    field("Battery weak voltage release in hybrid mode", INT_TENTHS, "V"),
    field("Battery Type", { kind: "option", options: ["Ordinary", "Li-Fe"] }, ""),
    field("Reserved", STRING, ""),
    field("Battery install date", STRING, "YYYYMMDDHHMMSS"),
    field(
      "AC charger keep battery voltage function enable/diable",
      { kind: "option", options: ["Disabled", "Enabled"] },
      ""
    ),
    field("AC charger keep battery voltage", INT_TENTHS, "V"),
    field("Battery temperature sensor compensation", INT_TENTHS, "mV"),
    field("Max. AC charging current", INT_TENTHS, "A"),
    field("Battery discharge max current in hybrid mode", INT, "A"),
    // The MPI 15K answers BATS with only the first 18 fields; these three exist on other PI17
    // machines (see the longer test_responses in the mpp-solar fork) and decode when present.
    field("Enable/Disable EPS function", { kind: "option", options: ["Disabled", "Enabled"] }, ""),
    field("Battery voltage of cut-off Main output in battery mode", INT_TENTHS, "V"),
    field("Battery voltage of re-connecting Main output in battery mode", INT_TENTHS, "V"),
  ],
  HECS: [
    field(
      "Solar Energy Distribution Priority",
      {
        kind: "str_keyed",
        mapping: { "00": "Battery-Load-Grid", "01": "Load-Battery-Grid", "02": "Load-Grid-Battery" },
      },
      ""
    ),
    field("Solar charge battery", ENABLED_DISABLED, ""),
    field("AC charge battery", ENABLED_DISABLED, ""),
    field("Feed power to utility", ENABLED_DISABLED, ""),
    field("Battery discharge to loads when solar input normal", ENABLED_DISABLED, ""),
    field("Battery discharge to loads when solar input loss", ENABLED_DISABLED, ""),
    field("Battery discharge to feed grid when solar input normal", ENABLED_DISABLED, ""),
    field("Battery discharge to feed grid when solar input loss", ENABLED_DISABLED, ""),
    field("Reserved", { kind: "exclude" }, ""),
  ],
  GPMP: [field("Maximum Feeding Grid power", INT, "W")],
  MOD: [field("Working mode", { kind: "str_keyed", mapping: WORKING_MODE_TEXT_BY_CODE }, "")],
  // ^D008AA,BB: the LATEST fault code (sticky, so not an active-fault flag) and its flash slot 0–8
  CFS: [field("Latest fault code", INT, ""), field("Latest fault record id", INT, "")],
  // The spec's flags A–X. This firmware answers the first 23, through "Equalization state", which
  // reads 1 every night together with A/B (so it means nothing alarming here); mpp-solar knows 22.
  WS: [
    warningFlag("Solar input 1 loss"),
    warningFlag("Solar input 2 loss"),
    warningFlag("Solar input 1 voltage too high"),
    warningFlag("Solar input 2 voltage too high"),
    // Not mpp-solar's "Battery under voltage": that name derives the key of a BATS setting
    warningFlag("Battery voltage under limit"),
    warningFlag("Battery voltage low"),
    warningFlag("Battery disconnected"),
    warningFlag("Battery over voltage"),
    warningFlag("Battery low in hybrid mode"),
    warningFlag("Grid voltage high loss"),
    warningFlag("Grid voltage low loss"),
    warningFlag("Grid frequency high loss"),
    warningFlag("Grid frequency low loss"),
    warningFlag("AC input long-time average voltage over"),
    warningFlag("AC input voltage loss"),
    warningFlag("AC input frequency loss"),
    warningFlag("AC input island"),
    warningFlag("AC input phase dislocation"),
    warningFlag("Over temperature"),
    warningFlag("Over load"),
    warningFlag("Emergency power off active"),
    warningFlag("AC input wave loss"),
    warningFlag("Equalization state"),
    warningFlag("Rapid shutdown active"),
  ],
  // ^P006HFSnn: the fault record in flash slot nn, 25 fixed-width tokens. The 2022 spec's layout
  // doesn't fit this firmware: the layout below is inferred from the nine records read on
  // 2026-10-26, matched against the Influx frames of the incidents they hold. Exact matches: the
  // battery token, 52.3 V in the 2025-04-13 F23 and 51.8 V in the 2025-06-30 F57; that F57's grid
  // 246.4/246.8 V, 221/247/221 VA, 4 % load and 80/99 °C; the 2026-10-21 F14's grid R 237.1 V and
  // VA R 94. The output voltages are phases S and T (the record has no R): wherever a record's grid
  // R differs from S/T they follow grid S/T, and three records match Influx's output S/T. Tokens no
  // reading fits stay verbatim strings ("unidentified"): the "time" reads 7599… and the "work mode"
  // 66, 84 … in all but one record; 4–6 look like PV but read ~110 V at night where Influx had 0 V;
  // 12 is 7599 in every record; 13 is signed but positive while discharging; 23 and 24 are 000 in
  // every record. The "Fault record" prefix keeps the names from colliding with the live GS fields
  // (and their plausibility ranges).
  HFS: [
    // The firmware leaves this 00 in every slot: a record is filed under the slot that was asked for
    field("Fault record id", INT, ""),
    field("Fault record fault code", INT, ""),
    field("Fault record time", STRING, ""),
    field("Fault record work mode", STRING, ""),
    field("Fault record unidentified 4", STRING, ""),
    field("Fault record unidentified 5", STRING, ""),
    field("Fault record unidentified 6", STRING, ""),
    field("Fault record AC input voltage R", INT_TENTHS, "V"),
    field("Fault record AC input voltage S", INT_TENTHS, "V"),
    field("Fault record AC input voltage T", INT_TENTHS, "V"),
    field("Fault record AC input frequency", INT_HUNDREDTHS, "Hz"),
    field("Fault record battery voltage", INT_TENTHS, "V"),
    field("Fault record unidentified 12", STRING, ""),
    field("Fault record unidentified 13", STRING, ""),
    field("Fault record AC output voltage S", INT_TENTHS, "V"),
    field("Fault record AC output voltage T", INT_TENTHS, "V"),
    field("Fault record AC output frequency", INT_HUNDREDTHS, "Hz"),
    field("Fault record AC output apparent power R", INT, "VA"),
    field("Fault record AC output apparent power S", INT, "VA"),
    field("Fault record AC output apparent power T", INT, "VA"),
    field("Fault record AC output load percentage", INT, "%"),
    field("Fault record inner temperature", INT, "°C"),
    field("Fault record component max temperature", INT, "°C"),
    field("Fault record unidentified 23", STRING, ""),
    field("Fault record unidentified 24", STRING, ""),
  ],
};

/**
 * WS flags this inverter sets every night (the datalogger's 2026-10 uploads: A, B and the 23rd), so
 * they say nothing about a fault: alert texts leave them out, the log and the /system card keep them.
 */
export const WARNING_FLAGS_SET_EVERY_NIGHT: ReadonlySet<string> = new Set([
  "Solar input 1 loss",
  "Solar input 2 loss",
  "Equalization state",
]);

/** A WS flag: "0" clear, "1" set; anything else decodes as an invalid option, which the gate drops */
function warningFlag(name: string): Pi17FieldSpec {
  return field(name, WARNING_FLAG, "");
}
