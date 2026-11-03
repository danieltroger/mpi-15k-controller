/**
 * The weather forecast the planner's price outlook reads, kept between plans. A plan reuses it while it is
 * younger than terminal_value_forecast_max_age_hours and otherwise fetches a new one: one fetch at a time,
 * shared by a plan that arrives while it runs. After a failed fetch none is tried again within the retry
 * interval, so plans fall back at once instead of each waiting on open-meteo again. A failing streak is
 * warned about once (each plan's notes quote the reason) and its end logged.
 *
 * The state lives in an explicit object so the selftest gets its own; the live trader uses
 * LIVE_OUTLOOK_WEATHER_CACHE.
 */
import { logLog, warnLog } from "../utilities/logging.ts";
import { describeError } from "../solar/errorDescription.ts";
import type { OutlookWeather } from "./priceOutlook.types.ts";

export type OutlookWeatherCache = {
  weather: OutlookWeather | undefined;
  inFlight: Promise<void> | undefined;
  /** The last fetch's failure; failingSinceMs is when the current streak started */
  failure: { atMs: number; failingSinceMs: number; reason: string } | undefined;
};

export type OutlookWeatherRequest = {
  nowMs: number;
  maxAgeMs: number;
  /** How long after a failed fetch no new one is started */
  retryAfterFailureMs: number;
  /** The forecast now, or throws why there is none (priceOutlookWeather.requireOutlookWeather) */
  fetchWeather: (nowMs: number) => Promise<OutlookWeather>;
};

export type OutlookWeatherResult =
  | { weather: OutlookWeather; problem?: undefined }
  | { weather?: undefined; problem: string };

export const LIVE_OUTLOOK_WEATHER_CACHE: OutlookWeatherCache = emptyOutlookWeatherCache();

/**
 * Main: a forecast at most maxAgeMs old, fetched if the cached one is older (or absent), or why there is
 * none. Never rejects. Waits for a running fetch however long it takes: the caller bounds its wait.
 */
export async function outlookWeatherNoOlderThan(
  cache: OutlookWeatherCache,
  request: OutlookWeatherRequest
): Promise<OutlookWeatherResult> {
  const { nowMs, maxAgeMs, retryAfterFailureMs, fetchWeather } = request;
  if (cache.weather && isFresh(cache.weather, nowMs, maxAgeMs)) return { weather: cache.weather };
  if (!cache.inFlight && !inFailureBackoff(cache, nowMs, retryAfterFailureMs)) {
    cache.inFlight = refreshWeather(cache, fetchWeather, nowMs);
  }
  if (cache.inFlight) await cache.inFlight;
  if (cache.weather && isFresh(cache.weather, nowMs, maxAgeMs)) return { weather: cache.weather };
  return { problem: whyNoFreshWeather(cache, nowMs, maxAgeMs, retryAfterFailureMs) };
}

export function emptyOutlookWeatherCache(): OutlookWeatherCache {
  return { weather: undefined, inFlight: undefined, failure: undefined };
}

async function refreshWeather(
  cache: OutlookWeatherCache,
  fetchWeather: OutlookWeatherRequest["fetchWeather"],
  nowMs: number
): Promise<void> {
  try {
    cache.weather = await fetchWeather(nowMs);
    if (cache.failure) {
      logLog(
        `Price outlook: weather forecast fetched again (failing since ${new Date(cache.failure.failingSinceMs).toISOString()})`
      );
    }
    cache.failure = undefined;
  } catch (error) {
    const reason = describeError(error);
    if (!cache.failure) warnLog(`Price outlook: ${reason} — plans fall back to the trailing mean until a fetch works`);
    cache.failure = { atMs: nowMs, failingSinceMs: cache.failure?.failingSinceMs ?? nowMs, reason };
  } finally {
    cache.inFlight = undefined;
  }
}

function isFresh(weather: OutlookWeather, nowMs: number, maxAgeMs: number): boolean {
  return nowMs - weather.fetchedAtMs <= maxAgeMs;
}

function inFailureBackoff(cache: OutlookWeatherCache, nowMs: number, retryAfterFailureMs: number): boolean {
  return cache.failure !== undefined && nowMs < cache.failure.atMs + retryAfterFailureMs;
}

function whyNoFreshWeather(
  cache: OutlookWeatherCache,
  nowMs: number,
  maxAgeMs: number,
  retryAfterFailureMs: number
): string {
  const failure = cache.failure
    ? `${cache.failure.reason}${inFailureBackoff(cache, nowMs, retryAfterFailureMs) ? `, next try after ${new Date(cache.failure.atMs + retryAfterFailureMs).toISOString()}` : ""}`
    : "no fetch has finished yet";
  if (!cache.weather) return `no weather forecast: ${failure}`;
  const ageHours = (nowMs - cache.weather.fetchedAtMs) / 3600_000;
  return `the weather forecast is ${ageHours.toFixed(1)} h old (max ${maxAgeMs / 3600_000} h) and refreshing it failed: ${failure}`;
}
