import { type Accessor, createEffect, createMemo, on, untrack } from "solid-js";
import type { Config } from "../config/config.types.ts";
import type { SweepLogger } from "./thermometerSweep.ts";
import {
  effectiveThermometerSweepSetting,
  THERMOMETER_SWEEP_SETTING_BOUNDS,
  type ThermometerSweepSettingName,
  type ThermometerSweepSettings,
} from "./thermometerSweepSettings.ts";

export type LiveThermometerSweepSettings = { [SettingName in ThermometerSweepSettingName]: Accessor<number> };

/**
 * Each temperature_saving.thermometer_* setting as a live value, corrected to its bounds. A bad value warns once
 * per value, and every change is logged, so a tuning experiment shows in the log where its effect starts.
 */
export function useThermometerSweepSettings(
  getConfig: Accessor<Config>,
  logger: SweepLogger
): LiveThermometerSweepSettings {
  return {
    thermometer_sweep_interval_seconds: useSweepSetting(getConfig, "thermometer_sweep_interval_seconds", logger),
    thermometer_silent_page_after_minutes: useSweepSetting(getConfig, "thermometer_silent_page_after_minutes", logger),
    thermometer_bulk_retry_interval_seconds: useSweepSetting(
      getConfig,
      "thermometer_bulk_retry_interval_seconds",
      logger
    ),
  };
}

/** The values one sweep runs with, read without subscribing the caller */
export function currentSweepSettings(liveSettings: LiveThermometerSweepSettings): ThermometerSweepSettings {
  return {
    thermometer_sweep_interval_seconds: untrack(liveSettings.thermometer_sweep_interval_seconds),
    thermometer_silent_page_after_minutes: untrack(liveSettings.thermometer_silent_page_after_minutes),
    thermometer_bulk_retry_interval_seconds: untrack(liveSettings.thermometer_bulk_retry_interval_seconds),
  };
}

function useSweepSetting(
  getConfig: Accessor<Config>,
  settingName: ThermometerSweepSettingName,
  logger: SweepLogger
): Accessor<number> {
  // The config signal changes as a whole: memoising the raw value first means a bad value warns once, not on
  // every unrelated config write
  const configuredValue = createMemo(() => getConfig().temperature_saving[settingName]);
  const effectiveSetting = createMemo(() => effectiveThermometerSweepSetting(settingName, configuredValue()));
  const value = createMemo(() => effectiveSetting().value);
  createEffect(() => {
    const { correction } = effectiveSetting();
    if (correction) logger.warn(`temperature_saving.${settingName}:`, correction);
  });
  createEffect(
    on(value, (currentValue, previousValue) => {
      if (previousValue === undefined) return;
      const { unit } = THERMOMETER_SWEEP_SETTING_BOUNDS[settingName];
      logger.log(`temperature_saving.${settingName}: ${previousValue} → ${currentValue} ${unit}, from the next sweep`);
    })
  );
  return value;
}
