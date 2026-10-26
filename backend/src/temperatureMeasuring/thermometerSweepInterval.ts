/**
 * temperature_saving.thermometer_sweep_interval_seconds as the sweep loop uses it, and what the cadence
 * means for whoever judges a reading's age. Pure (type-only imports): the config page shares the bounds.
 */
import type { TemperatureSavingConfig } from "../config/config.types.ts";

/**
 * Keeps each probe on about the cadence it had when every read ran its own conversion (one probe every
 * ~0.8 s, so each probe every ~11 s): MQTT/Influx volume and Grafana see the rhythm they saw before #69.
 */
export const DEFAULT_THERMOMETER_SWEEP_INTERVAL_SECONDS = 10;
/**
 * The battery and cooling-outlet alerts act on the newest reading, so they lag by up to one interval.
 * 5 min is small next to the ~80 min warning the outlet P2 would have given on 2025-06-30.
 */
export const MAX_THERMOMETER_SWEEP_INTERVAL_SECONDS = 300;
/**
 * A reading counts as stale only once it is this many intervals old (two whole sweeps missed), so a slow
 * cadence alone can't trip the stale-thermometers P2 or grey out the dashboard's dots.
 */
const STALE_AFTER_SWEEP_INTERVALS = 3;

export type SweepIntervalSetting = {
  intervalSeconds: number;
  /** Why intervalSeconds differs from the configured value, when it had to be corrected */
  correction: string | undefined;
};

/**
 * 0 is valid and means back to back, as is anything shorter than a sweep (~1.2 s): the loop measures start
 * to start and never overlaps sweeps. Takes `unknown` because config.json is hand-editable.
 */
export function effectiveSweepIntervalSeconds(configuredSeconds: unknown): SweepIntervalSetting {
  if (typeof configuredSeconds !== "number" || !Number.isFinite(configuredSeconds) || configuredSeconds < 0) {
    return {
      intervalSeconds: DEFAULT_THERMOMETER_SWEEP_INTERVAL_SECONDS,
      correction: `${describeConfiguredValue(configuredSeconds)} is not a non-negative number of seconds, using the default ${DEFAULT_THERMOMETER_SWEEP_INTERVAL_SECONDS} s`,
    };
  }
  if (configuredSeconds > MAX_THERMOMETER_SWEEP_INTERVAL_SECONDS) {
    return {
      intervalSeconds: MAX_THERMOMETER_SWEEP_INTERVAL_SECONDS,
      correction: `${configuredSeconds} s exceeds the ${MAX_THERMOMETER_SWEEP_INTERVAL_SECONDS} s maximum (the temperature alerts would lag too far behind), using the maximum`,
    };
  }
  return { intervalSeconds: configuredSeconds, correction: undefined };
}

/** How old the newest reading may get before it counts as stale: `minimumMs`, or three sweep intervals when that is longer */
export function temperatureStaleAfterMs(
  minimumMs: number,
  temperatureSaving: Partial<TemperatureSavingConfig> | undefined
): number {
  const { intervalSeconds } = effectiveSweepIntervalSeconds(temperatureSaving?.thermometer_sweep_interval_seconds);
  return Math.max(minimumMs, STALE_AFTER_SWEEP_INTERVALS * intervalSeconds * 1000);
}

function describeConfiguredValue(configuredSeconds: unknown): string {
  return typeof configuredSeconds === "number" || configuredSeconds === undefined
    ? String(configuredSeconds)
    : JSON.stringify(configuredSeconds);
}
