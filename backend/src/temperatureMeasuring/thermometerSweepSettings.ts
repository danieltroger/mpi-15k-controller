/**
 * The thermometer sweep's settings (temperature_saving.thermometer_*) as the backend uses them: their bounds,
 * the correction of a value outside them, and what the sweep cadence means for whoever judges a reading's age.
 * Pure (type-only imports): the config page shares the bounds.
 */
import type { TemperatureSavingConfig } from "../config/config.types.ts";

export type ThermometerSweepSettingName = Exclude<keyof TemperatureSavingConfig, "database" | "table">;

export type ThermometerSweepSettings = Pick<TemperatureSavingConfig, ThermometerSweepSettingName>;

export type SettingBounds = { defaultValue: number; min: number; max: number; unit: "s" | "min" };

export type EffectiveSetting = {
  value: number;
  /** Why `value` differs from the configured value, when it had to be corrected */
  correction: string | undefined;
};

export const THERMOMETER_SWEEP_SETTING_BOUNDS = {
  // The default keeps each probe on about the cadence it had when every read ran its own conversion (one probe
  // every ~0.8 s, so each probe every ~11 s): MQTT/Influx volume and Grafana see the rhythm they saw before #69.
  // 0 is back to back. The battery P1 (45 °C on a cell or bus bar) acts on the newest reading with no freshness
  // check, so a sweep interval makes it late by up to that interval: 60 s keeps it at most ~1 min late, where a
  // loose bus-bar joint at ~290 A could matter. A dark probe (whose cell the P1 can't see) pages after the silent
  // delay or 3 failed sweeps, whichever is later, so at 60 s after 3 min at most at the default delay.
  thermometer_sweep_interval_seconds: { defaultValue: 10, min: 0, max: 60, unit: "s" },
  // Under a minute, a probe throwing a run of CRC errors would page. Past an hour, a dark battery probe is no
  // early warning any more: it hides the cell it watches (cell_5 was dark 40 min on 2026-10-17 unnoticed).
  thermometer_silent_page_after_minutes: { defaultValue: 5, min: 1, max: 60, unit: "min" },
  // Each failed attempt can add a conversion's wait (~1 s) to a sweep that then reads probe by probe (~11 s);
  // past an hour, a fixed udev rule or kernel would leave the sweeps on the slow path that long.
  thermometer_bulk_retry_interval_seconds: { defaultValue: 60, min: 10, max: 3600, unit: "s" },
} as const satisfies Record<ThermometerSweepSettingName, SettingBounds>;

const STALE_AFTER_SWEEP_INTERVALS = 3;

export const DEFAULT_THERMOMETER_SWEEP_SETTINGS: ThermometerSweepSettings = {
  thermometer_sweep_interval_seconds: THERMOMETER_SWEEP_SETTING_BOUNDS.thermometer_sweep_interval_seconds.defaultValue,
  thermometer_silent_page_after_minutes:
    THERMOMETER_SWEEP_SETTING_BOUNDS.thermometer_silent_page_after_minutes.defaultValue,
  thermometer_bulk_retry_interval_seconds:
    THERMOMETER_SWEEP_SETTING_BOUNDS.thermometer_bulk_retry_interval_seconds.defaultValue,
};

/**
 * A value that isn't a non-negative number falls back to the default; one outside the bounds is clamped to
 * them. Takes `unknown` because config.json is hand-editable.
 */
export function effectiveThermometerSweepSetting(
  settingName: ThermometerSweepSettingName,
  configuredValue: unknown
): EffectiveSetting {
  const { defaultValue, min, max, unit } = THERMOMETER_SWEEP_SETTING_BOUNDS[settingName];
  if (typeof configuredValue !== "number" || !Number.isFinite(configuredValue) || configuredValue < 0) {
    return {
      value: defaultValue,
      correction: `${describeConfiguredValue(configuredValue)} is not a non-negative number of ${unitName(unit)}, using the default ${defaultValue} ${unit}`,
    };
  }
  if (configuredValue < min) {
    return {
      value: min,
      correction: `${configuredValue} ${unit} is below the ${min} ${unit} minimum, using the minimum`,
    };
  }
  if (configuredValue > max) {
    return {
      value: max,
      correction: `${configuredValue} ${unit} exceeds the ${max} ${unit} maximum, using the maximum`,
    };
  }
  return { value: configuredValue, correction: undefined };
}

/**
 * How old the newest reading may get before it counts as stale: `minimumMs`, or three sweep intervals when that
 * is longer (two whole sweeps missed), so a slow cadence alone can't trip the stale-thermometers P2 or grey out
 * the dashboard's dots.
 */
export function temperatureStaleAfterMs(
  minimumMs: number,
  temperatureSaving: Partial<TemperatureSavingConfig> | undefined
): number {
  const sweepInterval = effectiveThermometerSweepSetting(
    "thermometer_sweep_interval_seconds",
    temperatureSaving?.thermometer_sweep_interval_seconds
  );
  return Math.max(minimumMs, STALE_AFTER_SWEEP_INTERVALS * sweepInterval.value * 1000);
}

function describeConfiguredValue(configuredValue: unknown): string {
  return typeof configuredValue === "number" || configuredValue === undefined
    ? String(configuredValue)
    : JSON.stringify(configuredValue);
}

function unitName(unit: SettingBounds["unit"]) {
  return unit === "s" ? "seconds" : "minutes";
}
