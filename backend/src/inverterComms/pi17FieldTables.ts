/**
 * PI17 response field tables, ported verbatim from the repo owner's mpp-solar fork (pi17.py).
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

/** "Solar input voltage 1" → "solar_input_voltage_1" — mpp-solar's influx2_mqtt naming, byte-exact. */
export function influxFieldName(humanReadableName: string): string {
  return humanReadableName.replaceAll(" ", "_").toLowerCase();
}

const INT: Pi17FieldReading = { kind: "int", divisor: 1 };
const INT_TENTHS: Pi17FieldReading = { kind: "int", divisor: 10 };
const INT_HUNDREDTHS: Pi17FieldReading = { kind: "int", divisor: 100 };
const STRING: Pi17FieldReading = { kind: "string" };
const ENABLED_DISABLED: Pi17FieldReading = { kind: "option", options: ["disabled", "enabled"] };

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
  MOD: [
    field(
      "Working mode",
      {
        kind: "str_keyed",
        mapping: {
          "00": "Power on mode",
          "01": "Standby mode",
          "02": "Bypass mode",
          "03": "Battery mode",
          "04": "Fault mode",
          "05": "Hybrid mode (Line mode, Grid mode)",
          "06": "Charge mode",
        },
      },
      ""
    ),
  ],
};
