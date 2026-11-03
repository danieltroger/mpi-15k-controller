/**
 * The meter calibration the backend uses: config meter_calibration corrected to its bounds
 * (meterCalibrationBounds.ts), with a warning per distinct correction rather than per use — the live
 * derivation reads it on every PS round (~50 a minute), the planner on every plan run and the settlement
 * once a day.
 */
import type { MeterCalibrationConfig } from "../config/config.types.ts";
import { warnLog } from "../utilities/logging.ts";
import { effectiveMeterCalibration, type MeterCalibrationSettingName } from "./meterCalibrationBounds.ts";

let lastWarnedCorrections = "";

export function correctedMeterCalibration(
  configured: Partial<Record<MeterCalibrationSettingName, unknown>> | undefined
): MeterCalibrationConfig {
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
