/**
 * Bounds and defaults of the meter calibration (config meter_calibration, grid/meterEquivalentGrid.ts), and
 * the correction of a value outside them (config.json is hand-editable; the config page's min/max are only
 * input hints). Pure (no Node built-ins): the config page shares the bounds. The warn-once wrappers the
 * backend uses are in correctedMeterCalibration.ts.
 *
 * The defaults come from the 2026-11-03 calibration: the inverter's 1-min grid readings (phase sum, R's
 * sign repaired) against the meter's 15-min import and export registers, 2025-10 → 2026-11, net of a small
 * grid-side shed load. Each held within ±10 W across the 2026-07-03 pi17 fix and the 2026-10-25
 * native-serial cutover.
 */
import type { MeterCalibration } from "../config/config.types.ts";
import { effectiveBoundedNumber, type NumberSettingBounds } from "../config/boundedNumberSetting.ts";

export type MeterCalibrationSettingName = keyof MeterCalibration;

export type MeterCalibrationBounds = NumberSettingBounds & { unit: "W" | "W/kW²"; step: number };

export const METER_CALIBRATION_BOUNDS = {
  // Median meter − |reading| on steady exporting quarters: the night feed 197–206 W (reading ~250 W, the
  // meter ~48 W), feeding while PV charges 199–210 W, the same before and after the native-serial cutover.
  // 500 W is past anything the plant has shown; at 0 the meter is assumed to get the whole reading.
  export_draw_watts: { defaultValue: 200, min: 0, max: 500, unit: "W", step: 5 },
  // The gap grows with the power: 215 W at 5 kW, 270 W at 9 kW, 325 W at 11 kW, 454 W at 14.5 kW (a sell:
  // the meter gets 0.969 × the reading). 200 W + 1.2 W/kW² × P² is within ~30 W of every bin.
  export_watts_per_kw_squared: { defaultValue: 1.2, min: 0, max: 5, unit: "W/kW²", step: 0.1 },
  // Importing with the converter running: a hold or small charge 203–216 W, the battery covering part of the
  // house at night 203 W, the intercept of the buy-window curve ~220 W.
  import_draw_converting_watts: { defaultValue: 210, min: 0, max: 500, unit: "W", step: 5 },
  // Importing with the converter idle (dc/ac direction Idle: the house passes straight through) 96–112 W.
  import_draw_pass_through_watts: { defaultValue: 105, min: 0, max: 500, unit: "W", step: 5 },
  // Buy windows: meter − reading grows from 226 W at 1.5 kW to 608 W at 12.5 kW and 747 W at 14.5 kW (×1.051).
  // 210 W + 2.5 W/kW² × P² is within ~25 W from 1.5 to 15.5 kW; a plain gain (×1.037) misses by 95–125 W at
  // 5–11 kW.
  import_watts_per_kw_squared: { defaultValue: 2.5, min: 0, max: 5, unit: "W/kW²", step: 0.1 },
  // The planner simulates a feed-in limit, the inverter reports what reached its grid terminals: the night
  // feed at 350 W reads ~250 W (n = 8876 quarters) and 10 kW sells read ~9.88 kW. When the 15 kW rating is
  // what caps a sell (rating − house), the reading matches the planner's figure, so this isn't subtracted.
  feed_in_setpoint_shortfall_watts: { defaultValue: 100, min: 0, max: 300, unit: "W", step: 10 },
} as const satisfies Record<MeterCalibrationSettingName, MeterCalibrationBounds>;

export const DEFAULT_METER_CALIBRATION: MeterCalibration = {
  export_draw_watts: METER_CALIBRATION_BOUNDS.export_draw_watts.defaultValue,
  export_watts_per_kw_squared: METER_CALIBRATION_BOUNDS.export_watts_per_kw_squared.defaultValue,
  import_draw_converting_watts: METER_CALIBRATION_BOUNDS.import_draw_converting_watts.defaultValue,
  import_draw_pass_through_watts: METER_CALIBRATION_BOUNDS.import_draw_pass_through_watts.defaultValue,
  import_watts_per_kw_squared: METER_CALIBRATION_BOUNDS.import_watts_per_kw_squared.defaultValue,
  feed_in_setpoint_shortfall_watts: METER_CALIBRATION_BOUNDS.feed_in_setpoint_shortfall_watts.defaultValue,
};

/** Every setting 0: the meter is assumed to see exactly the reading, as before the calibration */
export const IDENTITY_METER_CALIBRATION: MeterCalibration = {
  export_draw_watts: 0,
  export_watts_per_kw_squared: 0,
  import_draw_converting_watts: 0,
  import_draw_pass_through_watts: 0,
  import_watts_per_kw_squared: 0,
  feed_in_setpoint_shortfall_watts: 0,
};

/**
 * The calibration with every setting corrected to its bounds: a value that isn't a non-negative number falls
 * back to the default, one outside the bounds is clamped. Takes `unknown` values: config.json is hand-editable
 * and a section may be missing keys a hand edit removed.
 */
export function effectiveMeterCalibration(configured: Partial<Record<MeterCalibrationSettingName, unknown>>): {
  calibration: MeterCalibration;
  corrections: string[];
} {
  const calibration: MeterCalibration = { ...DEFAULT_METER_CALIBRATION };
  const corrections: string[] = [];
  for (const settingName of Object.keys(METER_CALIBRATION_BOUNDS) as MeterCalibrationSettingName[]) {
    const { value, correction } = effectiveMeterCalibrationSetting(settingName, configured[settingName]);
    calibration[settingName] = value;
    if (correction) corrections.push(`meter_calibration.${settingName}: ${correction}`);
  }
  return { calibration, corrections };
}

export function effectiveMeterCalibrationSetting(
  settingName: MeterCalibrationSettingName,
  configuredValue: unknown
): { value: number; correction: string | undefined } {
  return effectiveBoundedNumber(METER_CALIBRATION_BOUNDS[settingName], configuredValue);
}

/** meter_calibration.apply_to_planner: only a boolean counts; anything else is the default (on), with a warning */
export function effectiveApplyToPlanner(configured: unknown): { value: boolean; correction: string | undefined } {
  if (typeof configured === "boolean") return { value: configured, correction: undefined };
  return {
    value: DEFAULT_APPLY_TO_PLANNER,
    correction: `meter_calibration.apply_to_planner: ${JSON.stringify(configured)} is not true or false, using ${DEFAULT_APPLY_TO_PLANNER}`,
  };
}

/**
 * On: the planner credits its revenue at what the meter counts, like the settlement does. Measured on 300 random
 * plans it changes about half of them and is about neutral at the meter (−0.09 SEK per plan): the buy margins
 * were tuned on the old, optimistic credits, so trades that only cleared them there now drop out.
 */
export const DEFAULT_APPLY_TO_PLANNER = true;
