/**
 * The meter calibration the backend uses: config meter_calibration corrected to its bounds
 * (meterCalibrationBounds.ts), with a warning per distinct correction rather than per use — the live
 * derivation reads it on every PS round (~50 a minute), the planner on every plan run and the settlement
 * once a day.
 */
import type { MeterCalibration, MeterCalibrationConfig } from "../config/config.types.ts";
import { warnLog } from "../utilities/logging.ts";
import {
  effectiveApplyToPlanner,
  effectiveMeterCalibration,
  IDENTITY_METER_CALIBRATION,
} from "./meterCalibrationBounds.ts";

type ConfiguredMeterCalibration = Partial<Record<keyof MeterCalibrationConfig, unknown>> | undefined;

let lastWarnedCorrections = "";
let lastWarnedApplyToPlannerCorrection: string | undefined;

/** The numbers the live fields and the settlement map readings with */
export function correctedMeterCalibration(configured: ConfiguredMeterCalibration): MeterCalibration {
  const { calibration, corrections } = effectiveMeterCalibration(configured ?? {});
  const summary = corrections.join("; ");
  if (summary !== lastWarnedCorrections) {
    if (summary) {
      warnLog(
        `${summary} (the settlement, the planner and the live meter-equivalent fields use that until it's fixed)`
      );
    }
    lastWarnedCorrections = summary;
  }
  return calibration;
}

/** What the planner credits its revenue with: the calibration, or the identity while apply_to_planner is off */
export function plannerMeterCalibration(configured: ConfiguredMeterCalibration): MeterCalibration {
  const { value: applyToPlanner, correction } = effectiveApplyToPlanner(configured?.apply_to_planner);
  if (correction !== lastWarnedApplyToPlannerCorrection) {
    if (correction) warnLog(`${correction} (the planner uses that until it's fixed)`);
    lastWarnedApplyToPlannerCorrection = correction;
  }
  const calibration = correctedMeterCalibration(configured);
  return applyToPlanner ? calibration : IDENTITY_METER_CALIBRATION;
}
