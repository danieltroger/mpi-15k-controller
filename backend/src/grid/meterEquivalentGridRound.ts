/**
 * Adds the meter-equivalent grid fields (meterEquivalentGrid.ts) to a decoded PS round, next to the raw
 * ones, so the live store, the ws and the MQTT → InfluxDB feed all carry them. Pure: the caller passes the
 * calibration. The raw fields are never touched.
 */
import type { MeterCalibrationConfig } from "../config/config.types.ts";
import type { DecodedFields, DecodedRound } from "../inverterComms/pi17Protocol.types.ts";
import { meterEquivalentGrid } from "./meterEquivalentGrid.ts";
import type {
  ConverterDirection,
  InverterGridReading,
  MeterEquivalentGridFieldName,
} from "./meterEquivalentGrid.types.ts";

export const METER_EQUIVALENT_GRID_FIELD_NAMES = [
  "meter_equivalent_grid_import_watts",
  "meter_equivalent_grid_export_watts",
] as const satisfies readonly MeterEquivalentGridFieldName[];

/**
 * The round with the derived fields added (PS only: it carries both the grid power and the converter
 * direction), or the reason a PS round couldn't be mapped. Other rounds come back unchanged.
 */
export function withMeterEquivalentGridFields(
  round: DecodedRound,
  calibration: MeterCalibrationConfig
): { round: DecodedRound; unmappable: string | undefined } {
  if (round.command !== "PS") return { round, unmappable: undefined };
  const reading = gridReadingOfFields(round.fields);
  if (typeof reading === "string") return { round, unmappable: reading };
  const meterEquivalent = meterEquivalentGrid(reading, calibration);
  // 0.1 W keeps the Influx lines as short as the raw ones'; the readings themselves are whole watts
  const derivedFields: Record<MeterEquivalentGridFieldName, number> = {
    meter_equivalent_grid_import_watts: roundToTenth(meterEquivalent.meter_equivalent_grid_import_watts),
    meter_equivalent_grid_export_watts: roundToTenth(meterEquivalent.meter_equivalent_grid_export_watts),
  };
  return { round: { ...round, fields: { ...round.fields, ...derivedFields } }, unmappable: undefined };
}

/** The grid reading in a PS round's fields, or why there is none */
export function gridReadingOfFields(fields: DecodedFields): InverterGridReading | string {
  const phaseSumWatts = fields.ac_input_total_active_power;
  const converterDirection = fields["dc/ac_power_direction"];
  if (typeof phaseSumWatts !== "number") {
    return `ac_input_total_active_power is ${JSON.stringify(phaseSumWatts)}, not a number`;
  }
  if (!isConverterDirection(converterDirection)) {
    return `dc/ac_power_direction is ${JSON.stringify(converterDirection)}, not a known direction`;
  }
  return { phase_sum_watts: phaseSumWatts, converter_direction: converterDirection };
}

export function isConverterDirection(value: unknown): value is ConverterDirection {
  return value === "DC to AC" || value === "AC to DC" || value === "Idle";
}

function roundToTenth(watts: number): number {
  return Math.round(watts * 10) / 10;
}
