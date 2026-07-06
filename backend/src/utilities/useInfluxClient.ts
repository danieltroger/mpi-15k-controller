import Influx from "influx";
import { type Accessor, createMemo } from "solid-js";
import type { Config } from "../config/config.types.ts";

// One client per distinct settings for the whole process, no matter how many hooks/roots ask —
// a solid-js provider would achieve the same but with wiring ceremony this stateless HTTP
// client doesn't warrant.
const clientsBySettings = new Map<string, Influx.InfluxDB>();

/**
 * Shared InfluxDB client accessor. Keyed on the actual influxdb settings so config writes that
 * don't touch them (schedule updates, auth refreshes) reuse the same client instance.
 */
export function useInfluxClient(config: Accessor<Config>) {
  const settingsJson = createMemo(() => JSON.stringify(config().influxdb ?? null));
  return createMemo(() => {
    const settings = JSON.parse(settingsJson()) as Config["influxdb"] | null;
    if (!settings?.host || !settings.database || !settings.username || !settings.password) return undefined;
    let client = clientsBySettings.get(settingsJson());
    if (!client) {
      client = new Influx.InfluxDB({ ...settings });
      clientsBySettings.set(settingsJson(), client);
    }
    return client;
  });
}
