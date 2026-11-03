/**
 * What the utility meter makes of the simulation's grid flows (simulate.ts): the planner's side of the meter
 * calibration (grid/meterEquivalentGrid.ts). The simulation keeps its flows as the inverter sees them (the
 * battery drain, the ramp, the energies it reports), and only its revenue is corrected: by the part of an
 * export the meter doesn't count, and by what it counts on top of an import. At the identity calibration
 * (every setting 0) both corrections are exactly 0, so the revenue is bit-for-bit the uncalibrated one.
 *
 * In the simulation a slot with no modelled flow exchanges nothing, though the real inverter feeds a little
 * there too (PV charging the battery). So an export smaller than the inverter's draw is credited as nothing,
 * never charged as an import: a battery that fills up must not look dearer than one that doesn't.
 */
import type { MeterCalibrationConfig } from "../config/config.types.ts";
import { meterExportShortfallWatts, meterImportExcessWatts } from "../grid/meterEquivalentGrid.ts";
import type { ConverterDirection } from "../grid/meterEquivalentGrid.types.ts";

/**
 * The part of a slot's modelled export the meter doesn't count (W, between 0 and the export). The export is
 * the feed (a sell or the baseline feed, as the planner sets it) plus the PV a full battery lets through; the
 * feed's reading sits readingShortfallW below it (feedReadingShortfallWatts).
 */
export function uncountedExportWatts(
  modelledExportW: number,
  readingShortfallW: number,
  calibration: MeterCalibrationConfig
): number {
  if (modelledExportW <= 0) return 0;
  const readingW = Math.max(0, modelledExportW - readingShortfallW);
  const meterW = readingW > 0 ? Math.max(0, readingW - meterExportShortfallWatts(readingW, calibration)) : 0;
  return modelledExportW - meterW;
}

/**
 * How far the inverter's reading falls below a modelled feed (W ≥ 0). The planner models a feed-in limit
 * capped by the rating less the house; the reading sits feed_in_setpoint_shortfall_watts below the limit
 * where the limit is what caps the feed (the baseline feed, a reduced-power sell), not where the rating does.
 */
export function feedReadingShortfallWatts(
  feedLimitW: number,
  ratingHeadroomW: number,
  calibration: MeterCalibrationConfig
): number {
  const modelledW = Math.max(0, Math.min(feedLimitW, ratingHeadroomW));
  const readingW = Math.max(0, Math.min(feedLimitW - calibration.feed_in_setpoint_shortfall_watts, ratingHeadroomW));
  return modelledW - readingW;
}

/**
 * What the meter counts on top of the house's import past an empty battery (W ≥ 0), with the converter idle
 * (the house straight on the grid). The battery may run out mid-slot: from then on the grid takes over the
 * slot's whole demand (`slotDemandW`, what the battery would have supplied), so the inverter's draw counts
 * only for that share of the slot.
 */
export function passThroughExtraImportWatts(
  importedW: number,
  slotDemandW: number,
  calibration: MeterCalibrationConfig
): number {
  const importingShare = slotDemandW > importedW ? importedW / slotDemandW : 1;
  return extraImportWatts(importedW / importingShare, importingShare, "Idle", calibration);
}

/**
 * What the meter counts on top of an import (W ≥ 0): one running at `importingW` (the inverter's reading)
 * for `importingShare` of the slot. A grid charge imports the whole slot; the house's import past an empty
 * battery may start mid-slot.
 */
export function extraImportWatts(
  importingW: number,
  importingShare: number,
  converterDirection: ConverterDirection,
  calibration: MeterCalibrationConfig
): number {
  if (importingW <= 0 || importingShare <= 0) return 0;
  return importingShare * meterImportExcessWatts(importingW, converterDirection, calibration);
}
