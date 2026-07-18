/**
 * Decodes PI17 data-response payloads into named fields — pure, no I/O. Field names replicate
 * mpp-solar's influx2_mqtt output exactly (see pi17FieldTables.ts) so InfluxDB series continue.
 */
import type { DecodedFields, Pi17QueryCommandName } from "./pi17Protocol.types.ts";
import { influxFieldName, PI17_QUERY_RESPONSE_FIELDS } from "./pi17FieldTables.ts";

export function decodeQueryPayload(
  command: Pi17QueryCommandName,
  payloadText: string
): { fields: DecodedFields; problems: string[] } {
  const fieldSpecs = PI17_QUERY_RESPONSE_FIELDS[command];
  const fields: DecodedFields = {};
  const problems: string[] = [];
  payloadText.split(",").forEach((token, tokenIndex) => {
    const spec = fieldSpecs[tokenIndex];
    if (!spec) {
      // mpp-solar names surplus tokens by their 0-based position — the live schema's
      // unknown_value_in_response_25 (GS occasionally sending a 26th field) proves the convention.
      if (token !== "") fields[`unknown_value_in_response_${tokenIndex}`] = token;
      return;
    }
    if (spec.reading.kind === "exclude") return;
    // The firmware legitimately sends some fields empty (GS AC output currents, PS battery power)
    if (token === "") return;
    const name = influxFieldName(spec.name);
    switch (spec.reading.kind) {
      case "int": {
        if (!/^[+-]?\d+$/.test(token)) {
          problems.push(`${command} field ${name}: unparseable integer ${JSON.stringify(token)}`);
          return;
        }
        fields[name] = Number(token) / spec.reading.divisor;
        return;
      }
      case "string": {
        fields[name] = token;
        return;
      }
      case "option": {
        const optionIndex = /^\d+$/.test(token) ? Number(token) : NaN;
        // mpp-solar renders out-of-range selectors as e.g. "Invalid option: 4" — the live schema
        // even allows that for setting_change_bit, so reproduce the exact wording.
        fields[name] = spec.reading.options[optionIndex] ?? `Invalid option: ${token}`;
        return;
      }
      case "str_keyed": {
        fields[name] = spec.reading.mapping[token] ?? `Unknown key: ${token}`;
        return;
      }
    }
  });
  if (command === "PS") fixMpiAcInputFields(fields);
  return { fields, problems };
}

/**
 * Work around MPI hybrid inverter firmware bugs in the PS response (observed on an MPI 15K,
 * firmware as of 2026) — exact port of the repo owner's mpp-solar fix ("pi17: repair MPI AC input
 * power fields around firmware bugs"); InfluxDB data continuity depends on it:
 *
 * - "AC input active power R" is transmitted without a sign (always >= 0), while phases S and T
 *   are correctly signed (negative = feeding the grid). R's true sign varies independently of the
 *   overall direction: an unbalanced house load can import on R while S and T export.
 * - "AC input total active power" is garbage whenever the true magnitude reaches 10000 W: frozen
 *   at exactly +7937 while exporting, and drifting/wrapping junk (roughly -31000..+9700) while
 *   importing. Below 10 kW it equals the phase sum with R's true sign, exactly.
 *
 * So: when the raw total matches the phase sum with either sign of R, the total is genuine — keep
 * it and recover R's sign from which one matched. Otherwise the total is firmware garbage: give R
 * the sign implied by "Line power direction" (per-phase magnitudes stay accurate in all regimes,
 * validated against battery power + PV - house consumption over weeks of data) and replace the
 * total with the reconstructed phase sum.
 */
export function fixMpiAcInputFields(fields: DecodedFields): void {
  const phaseR = fields.ac_input_active_power_r;
  const phaseS = fields.ac_input_active_power_s;
  const phaseT = fields.ac_input_active_power_t;
  const direction = fields.line_power_direction;
  const total = fields.ac_input_total_active_power;
  if (
    typeof phaseR !== "number" ||
    typeof phaseS !== "number" ||
    typeof phaseT !== "number" ||
    typeof total !== "number" ||
    typeof direction !== "string"
  ) {
    return;
  }
  const tolerance = 3; // fields come from the same frame; matches are exact in practice
  const sumWithPositiveR = Math.abs(phaseR) + phaseS + phaseT;
  const sumWithNegativeR = -Math.abs(phaseR) + phaseS + phaseT;
  let signedR: number;
  if (Math.abs(total - sumWithNegativeR) <= tolerance) {
    signedR = -Math.abs(phaseR);
  } else if (Math.abs(total - sumWithPositiveR) <= tolerance) {
    signedR = Math.abs(phaseR);
  } else {
    // Total is garbage — fall back to the overall flow direction for R's sign
    signedR = direction === "Output" ? -Math.abs(phaseR) : Math.abs(phaseR);
    fields.ac_input_total_active_power = signedR + phaseS + phaseT;
  }
  fields.ac_input_active_power_r = signedR;
}
