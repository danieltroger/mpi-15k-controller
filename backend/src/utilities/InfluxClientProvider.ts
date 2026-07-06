import Influx from "influx";
import { type Accessor, createContext, createMemo, type JSX, useContext } from "solid-js";
import type { Config } from "../config/config.types.ts";

const InfluxClientContext = createContext<Accessor<Influx.InfluxDB | undefined>>();

/**
 * Provides one shared InfluxDB client for the subtree, keyed on the actual influxdb settings so
 * config writes that don't touch them (schedule updates, auth refreshes) keep the same client and
 * only a real settings change swaps in a fresh one. Scoped to the owning root rather than a
 * process-global map, so the client is dropped when the root disposes (e.g. index.ts's restart
 * loop) instead of lingering — and stale clients from earlier settings become collectable once the
 * memo recomputes.
 */
export function InfluxClientProvider(props: { children: JSX.Element; config: Accessor<Config> }) {
  const settingsJson = createMemo(() => JSON.stringify(props.config().influxdb ?? null));
  const client = createMemo(() => {
    const settings = JSON.parse(settingsJson()) as Config["influxdb"] | null;
    if (!settings?.host || !settings.database || !settings.username || !settings.password) return undefined;
    return new Influx.InfluxDB({ ...settings });
  });

  return InfluxClientContext.Provider({
    value: client,
    get children() {
      return props.children;
    },
  });
}

/** Shared InfluxDB client accessor; undefined until the influxdb settings are fully configured. */
export function useInfluxClient() {
  const contextValue = useContext(InfluxClientContext);
  if (!contextValue) {
    throw new Error("useInfluxClient must be used within an InfluxClientProvider");
  }
  return contextValue;
}
