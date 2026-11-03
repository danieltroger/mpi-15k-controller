/**
 * What the utility meter counts for one inverter grid reading — pure, no I/O. The inverter's grid sensor
 * leaves out the inverter's own draw (its fans, control electronics and the converter's standby), and the
 * gap grows with the square of the power. Against the meter's 15-min registers (2025-10 → 2026-11):
 *
 * - exporting, from the battery or PV alike: meter ≈ |reading| − 200 W − 1.2 W/kW² × P² (the night feed's
 *   ~250 W reading reaches the meter as ~48 W; a 14.5 kW sell as 0.969 × the reading);
 * - importing with the converter running (charging, or the battery covering part of the house):
 *   meter ≈ reading + 210 W + 2.5 W/kW² × P² (+747 W in a 14.5 kW buy window);
 * - importing with the converter idle (the house straight on the grid): meter ≈ reading + 105 W (+ P² term);
 * - a reading of exactly 0 (the grid switched off, or the AC input relay open): the meter sees only the
 *   grid-side shed load, which the inverter can't measure, so 0.
 *
 * With every setting at 0 the result is exactly the reading split by sign. The numbers live in config
 * (meter_calibration, bounds and sources in meterCalibrationBounds.ts). Consumers that act on the
 * inverter's own measurement (the grid-amps guards, the buy-window step-down, the plausibility gate, stuck
 * detection, the hold breaker guard, the measured feed-in ramp seed) keep reading the raw fields.
 */
import type { MeterCalibration } from "../config/config.types.ts";
import type { ConverterDirection, InverterGridReading, MeterEquivalentGrid } from "./meterEquivalentGrid.types.ts";

export function meterEquivalentGrid(
  reading: InverterGridReading,
  calibration: MeterCalibration
): MeterEquivalentGrid {
  const meterNetImportWatts = meterNetImportWattsOf(reading, calibration);
  return {
    meter_equivalent_grid_import_watts: Math.max(0, meterNetImportWatts),
    meter_equivalent_grid_export_watts: Math.max(0, -meterNetImportWatts),
  };
}

/** The meter's net import for a reading (W; negative = exporting) */
export function meterNetImportWattsOf(reading: InverterGridReading, calibration: MeterCalibration): number {
  const phaseSumWatts = reading.phase_sum_watts;
  if (phaseSumWatts === 0) return 0;
  if (phaseSumWatts > 0) {
    return phaseSumWatts + meterImportExcessWatts(phaseSumWatts, reading.converter_direction, calibration);
  }
  // A small export can come out as a net import: the inverter's draw is larger than what it feeds
  return phaseSumWatts + meterExportShortfallWatts(-phaseSumWatts, calibration);
}

/** How much more than an import of `importWatts` (> 0, as the inverter reads it) the meter counts */
export function meterImportExcessWatts(
  importWatts: number,
  converterDirection: ConverterDirection,
  calibration: MeterCalibration
): number {
  const drawWatts =
    converterDirection === "Idle"
      ? calibration.import_draw_pass_through_watts
      : calibration.import_draw_converting_watts;
  return drawWatts + calibration.import_watts_per_kw_squared * (importWatts / 1000) ** 2;
}

/** How much less than an export of `exportWatts` (> 0, as the inverter reads it) the meter counts */
export function meterExportShortfallWatts(exportWatts: number, calibration: MeterCalibration): number {
  return calibration.export_draw_watts + calibration.export_watts_per_kw_squared * (exportWatts / 1000) ** 2;
}
