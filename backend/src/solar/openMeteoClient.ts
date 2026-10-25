import { promises as fs_promises } from "fs";
import { fileURLToPath } from "url";
import { warnLog } from "../utilities/logging.ts";
import { describeError } from "./errorDescription.ts";
import { parseOpenMeteoHourly, RADIATION_VARIABLES, SNOW_VARIABLES } from "./openMeteoHourly.ts";
import type { RadiationHour } from "./solarModel.types.ts";
import type { RadiationArchiveColumns } from "./pvHistory.types.ts";

/**
 * Live best_match forecast with recent history (past_days). The history feeds the snow nowcast,
 * which compares each string's recent production against what this same forecast source implied.
 */
export async function fetchLiveRadiation(
  latitude: number,
  longitude: number,
  { pastDays, forecastDays }: { pastDays: number; forecastDays: number }
): Promise<RadiationHour[]> {
  const params = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    hourly: `${RADIATION_VARIABLES},${SNOW_VARIABLES}`,
    past_days: String(pastDays),
    forecast_days: String(forecastDays),
    timezone: "UTC",
  });
  return parseOpenMeteoHourly(await fetchJson(`${FORECAST_API}?${params}`));
}

export type RadiationArchiveSource = "satellite" | "forecast_archive";

/**
 * Hourly irradiance history for the refit on the history's hour grid, month by month, from either
 *  - satellite: open-meteo's satellite API, EUMETSAT SARAH-3 (30-min native, ~2 days behind real
 *    time; covers this site since 1983) — the best available "what the sun really did", or
 *  - forecast_archive: the Historical Forecast API, the same best_match model family the live
 *    forecast comes from (with its snow variables).
 * Finished months are cached on disk in solar_cache/ (see fetchArchiveMonth for gappy months).
 */
export async function fetchRadiationArchiveColumns(input: {
  source: RadiationArchiveSource;
  latitude: number;
  longitude: number;
  firstHourMs: number;
  hourCount: number;
}): Promise<RadiationArchiveColumns> {
  const columns: RadiationArchiveColumns = {
    globalHorizontal: new Float64Array(input.hourCount).fill(Number.NaN),
    diffuseHorizontal: new Float64Array(input.hourCount).fill(Number.NaN),
    directHorizontal: new Float64Array(input.hourCount).fill(Number.NaN),
    snowfallCm: new Float64Array(input.hourCount).fill(Number.NaN),
    snowDepthMetres: new Float64Array(input.hourCount).fill(Number.NaN),
  };
  const toMs = input.firstHourMs + input.hourCount * 3600_000;
  for (const month of monthsBetween(input.firstHourMs, toMs)) {
    for (const hour of await fetchArchiveMonth({ ...input, month })) {
      const index = (hour.hourStartMs - input.firstHourMs) / 3600_000;
      if (index < 0 || index >= input.hourCount) continue;
      columns.globalHorizontal[index] = hour.globalHorizontal;
      columns.diffuseHorizontal[index] = hour.diffuseHorizontal;
      columns.directHorizontal[index] = hour.directHorizontal;
      columns.snowfallCm[index] = hour.snowfallCm ?? Number.NaN;
      columns.snowDepthMetres[index] = hour.snowDepthMetres ?? Number.NaN;
    }
  }
  return columns;
}

const FORECAST_API = "https://api.open-meteo.com/v1/forecast";
const HISTORICAL_FORECAST_API = "https://historical-forecast-api.open-meteo.com/v1/forecast";
const SATELLITE_API = "https://satellite-api.open-meteo.com/v1/archive";
/** Generous: this pi's CPU is often pegged (SOC worker), which slows TLS and the event loop */
const REQUEST_TIMEOUT_MS = 60_000;
const CACHE_DIRECTORY = fileURLToPath(new URL("../../solar_cache/", import.meta.url));
/** A month is final (and cacheable) once it ended this long ago — the satellite runs ~2 days behind */
const MONTH_FINAL_AFTER_MS = 7 * 86_400_000;
const GAPS_PERMANENT_AFTER_MS = 30 * 86_400_000;

/**
 * One month, from the cache when possible. A finished month is cached with its fetch time; a
 * cached month with missing hours is refetched once it ended 30+ days ago (late-processed
 * satellite slots fill in), after which its gaps count as permanent.
 */
async function fetchArchiveMonth(input: {
  source: RadiationArchiveSource;
  latitude: number;
  longitude: number;
  month: { startMs: number; endMs: number; label: string };
}): Promise<RadiationHour[]> {
  const cachePath = `${CACHE_DIRECTORY}${input.source}_${input.latitude}_${input.longitude}_${input.month.label}.json`;
  const nowMs = Date.now();
  const final = input.month.endMs < nowMs - MONTH_FINAL_AFTER_MS;
  const expectedHours = (input.month.endMs + 86_400_000 - input.month.startMs) / 3600_000;
  if (final) {
    const cached = await readCachedMonth(cachePath);
    const gapsArePermanent = !!cached && Date.parse(cached.fetched_at) >= input.month.endMs + GAPS_PERMANENT_AFTER_MS;
    if (cached && (cached.hours.length >= expectedHours || gapsArePermanent)) return cached.hours;
  }
  // Labels mark the END of each averaged hour, so the month's first hour comes from the previous date
  const params = new URLSearchParams({
    latitude: String(input.latitude),
    longitude: String(input.longitude),
    start_date: isoDate(input.month.startMs),
    end_date: isoDate(Math.min(input.month.endMs, nowMs)),
    hourly: input.source === "satellite" ? RADIATION_VARIABLES : `${RADIATION_VARIABLES},${SNOW_VARIABLES}`,
    timezone: "UTC",
  });
  if (input.source === "satellite") params.set("models", "eumetsat_sarah3");
  const base = input.source === "satellite" ? SATELLITE_API : HISTORICAL_FORECAST_API;
  const hours = parseOpenMeteoHourly(await fetchJson(`${base}?${params}`));
  if (final) {
    const cached: CachedMonth = { fetched_at: new Date(nowMs).toISOString(), hours };
    await fs_promises.mkdir(CACHE_DIRECTORY, { recursive: true });
    await fs_promises.writeFile(`${cachePath}.tmp`, JSON.stringify(cached), { encoding: "utf-8" });
    await fs_promises.rename(`${cachePath}.tmp`, cachePath);
  }
  return hours;
}

type CachedMonth = { fetched_at: string; hours: RadiationHour[] };

async function readCachedMonth(cachePath: string): Promise<CachedMonth | undefined> {
  try {
    const parsed = JSON.parse(await fs_promises.readFile(cachePath, { encoding: "utf-8" })) as
      | CachedMonth
      | RadiationHour[];
    // Files from before the fetch time was recorded are refetched once
    return Array.isArray(parsed) ? undefined : parsed;
  } catch (error) {
    // A missing month is the normal first fetch; a corrupt one is refetched, but say so
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      warnLog("Solar model: unreadable irradiance cache file, refetching", cachePath, error);
    }
    return undefined;
  }
}

/** One retry after a pause: a single dropped connection shouldn't push a whole refit onto the fallback source */
async function fetchJson(url: string): Promise<unknown> {
  try {
    return await fetchJsonOnce(url);
  } catch (firstError) {
    await new Promise(resolve => setTimeout(resolve, RETRY_PAUSE_MS));
    try {
      return await fetchJsonOnce(url);
    } catch (secondError) {
      throw new Error(
        `open-meteo request failed twice (${describeError(firstError)}; ${describeError(secondError)}): ${url}`
      );
    }
  }
}

async function fetchJsonOnce(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

const RETRY_PAUSE_MS = 5_000;

function monthsBetween(fromMs: number, toMs: number): { startMs: number; endMs: number; label: string }[] {
  const months: { startMs: number; endMs: number; label: string }[] = [];
  const cursor = new Date(fromMs);
  let monthStart = Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), 1);
  while (monthStart < toMs) {
    const start = new Date(monthStart);
    const nextMonthStart = Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1);
    months.push({ startMs: monthStart, endMs: nextMonthStart - 86_400_000, label: isoDate(monthStart).slice(0, 7) });
    monthStart = nextMonthStart;
  }
  return months;
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
