import Influx from "influx";
import { type Accessor, createMemo } from "solid-js";
import type { Config } from "../config/config.types.ts";

/**
 * Shared InfluxDB client accessor. Keyed on the actual influxdb settings so config writes that
 * don't touch them (schedule updates, auth refreshes) reuse the same client instance.
 */
export function useInfluxClient(config: Accessor<Config>) {
  const settingsJson = createMemo(() => JSON.stringify(config().influxdb ?? null));
  return createMemo(() => {
    const settings = JSON.parse(settingsJson()) as Config["influxdb"] | null;
    if (!settings?.host || !settings.database || !settings.username || !settings.password) return undefined;
    return new Influx.InfluxDB({ ...settings });
  });
}
