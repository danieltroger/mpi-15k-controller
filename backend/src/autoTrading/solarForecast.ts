import { logLog, warnLog } from "../utilities/logging.ts";

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

  let radiationHours: RadiationHour[];
  try {
    radiationHours = await fetchRadiationByHour(latitude, longitude, { forecastDays: 4 });
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
  }

  const byHourMs = new Map<number, number>();
  const dailyKwh: Record<string, number> = {};
  for (const { hourMs, direct, diffuse } of radiationHours) {
    const watts = Math.max(0, wattsPerDirect * direct + wattsPerDiffuse * diffuse);
    byHourMs.set(hourMs, watts);
    const day = new Date(hourMs).toISOString().slice(0, 10);
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

/** One open-meteo radiation reading, bucketed to the start of its UTC hour. */
export type RadiationHour = { hourMs: number; direct: number; diffuse: number };

/**
 * Fetch open-meteo direct + diffuse radiation as one reading per UTC hour. Shared by the live PV
 * forecast (future hours, forecastDays) and the model calibration (trailing history, pastDays) so the
 * model is always fit on the exact same radiation signal it is later evaluated on — the requested
 * variables and endpoint live in one place and the two callers can't silently drift apart. Hours the
 * API reports as null are dropped.
 */
export async function fetchRadiationByHour(
  latitude: number,
  longitude: number,
  { pastDays, forecastDays }: { pastDays?: number; forecastDays?: number }
): Promise<RadiationHour[]> {
  const params = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    hourly: "direct_radiation,diffuse_radiation",
    forecast_days: String(forecastDays ?? 1),
    timezone: "UTC",
  });
  // open-meteo's forecast endpoint only serves ~3 months of history (currently 93 days);
  // a longer window 400s (surfaced above) rather than being silently truncated
  if (pastDays !== undefined) params.set("past_days", String(pastDays));

  const controller = new AbortController();
  // Generous timeout: this pi's CPU is often pegged (SOC worker) which slows TLS + event loop
  const timeout = setTimeout(() => controller.abort(), 60_000);
  let data: any;
  try {
    const response = await fetch(`${WEATHER_API_BASE}?${params}`, { signal: controller.signal });
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
  } finally {
    clearTimeout(timeout);
  }

  const times: string[] = data.hourly.time;
  const direct: (number | null)[] = data.hourly.direct_radiation;
  const diffuse: (number | null)[] = data.hourly.diffuse_radiation;
  const hours: RadiationHour[] = [];
  for (let i = 0; i < times.length; i++) {
    const directRadiation = direct[i];
    const diffuseRadiation = diffuse[i];
    if (directRadiation === null || diffuseRadiation === null) continue;
    hours.push({ hourMs: +new Date(times[i] + ":00Z"), direct: directRadiation, diffuse: diffuseRadiation });
  }
  return hours;
}
