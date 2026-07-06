import { logLog, warnLog } from "../utilities/logging.ts";
import { onCleanup } from "solid-js";

const WEATHER_API_BASE = "https://api.open-meteo.com/v1/forecast";

export type SolarForecast = {
  /** Forecast PV production in watts for a given time (stepwise per hour). 0 outside the fetched range. */
  wattsAt: (ms: number) => number;
  fetchedAtMs: number;
  rangeEndMs: number;
  /** Daily kWh sums, keyed by YYYY-MM-DD (UTC), for logging/status */
  dailyKwh: Record<string, number>;
};

let cache: { key: string; value: SolarForecast } | undefined;

/**
 * PV forecast from open-meteo direct + diffuse radiation with locally calibrated coefficients
 * (least-squares fit of actual inverter PV production vs open-meteo radiation history;
 * see automatic_trading.solar_model in the config).
 */
export async function fetchSolarForecast(
  latitude: number,
  longitude: number,
  wattsPerDirect: number,
  wattsPerDiffuse: number
): Promise<SolarForecast> {
  const key = [latitude, longitude, wattsPerDirect, wattsPerDiffuse].join("/");
  const maxAgeMs = 60 * 60 * 1000;
  if (cache && cache.key === key && Date.now() - cache.value.fetchedAtMs < maxAgeMs) return cache.value;

  const url = new URL(WEATHER_API_BASE);
  url.searchParams.set("latitude", String(latitude));
  url.searchParams.set("longitude", String(longitude));
  url.searchParams.set("hourly", "direct_radiation,diffuse_radiation");
  url.searchParams.set("forecast_days", "4");
  url.searchParams.set("timezone", "UTC");

  const controller = new AbortController();
  // Generous timeout: this pi's CPU is often pegged (SOC worker) which slows TLS + event loop
  const timeout = setTimeout(() => controller.abort(), 60_000);
  onCleanup(() => clearTimeout(timeout));
  let data: any;
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      console.error(
        "Weather API response text",
        await response.text(),
        "headers",
        Object.fromEntries(response.headers)
      );
      throw new Error(`Weather API returned ${response.status}`);
    }
    data = await response.json();
  } catch (e) {
    if (cache && cache.key === key) {
      warnLog(
        "Solar forecast fetch failed, using stale cache from",
        new Date(cache.value.fetchedAtMs).toISOString(),
        e
      );
      return cache.value;
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }

  const times: string[] = data.hourly.time;
  const direct: (number | null)[] = data.hourly.direct_radiation;
  const diffuse: (number | null)[] = data.hourly.diffuse_radiation;

  const byHourMs = new Map<number, number>();
  const dailyKwh: Record<string, number> = {};
  for (let i = 0; i < times.length; i++) {
    const ms = +new Date(times[i] + ":00Z");
    const watts = Math.max(0, wattsPerDirect * (direct[i] ?? 0) + wattsPerDiffuse * (diffuse[i] ?? 0));
    byHourMs.set(ms, watts);
    const day = times[i].slice(0, 10);
    dailyKwh[day] = (dailyKwh[day] ?? 0) + watts / 1000;
  }
  const rangeEndMs = Math.max(...byHourMs.keys()) + 3600_000;

  const value: SolarForecast = {
    wattsAt: ms => byHourMs.get(Math.floor(ms / 3600_000) * 3600_000) ?? 0,
    fetchedAtMs: Date.now(),
    rangeEndMs,
    dailyKwh,
  };
  cache = { key, value };
  logLog(
    "Fetched solar forecast, daily kWh estimates:",
    Object.entries(dailyKwh)
      .map(([d, kwh]) => `${d}: ${kwh.toFixed(0)}`)
      .join(", ")
  );
  return value;
}
