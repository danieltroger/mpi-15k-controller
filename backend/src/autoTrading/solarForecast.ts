import type Influx from "influx";
import type { AutomaticTradingConfig } from "../config/config.types.ts";
import { logLog, warnLog } from "../utilities/logging.ts";
import { fetchLiveRadiation } from "../solar/openMeteoClient.ts";
import { influxClientQuery } from "../solar/influxQuery.ts";
import { queryHourlyStringWatts } from "../solar/pvHistory.ts";
import { defaultHorizonMask, type StringCoefficients } from "../solar/pvModel.ts";
import { buildSolarForecast, SOLAR_STRING_KEYS, type BuiltSolarForecast } from "../solar/solarForecastModel.ts";
import { loadSolarModelState } from "../solar/solarModelStore.ts";
import { fittedGeometryMatches, stringGeometries } from "../solar/solarModelGeometry.ts";
import type { SolarModelFit, SolarStringKey } from "../solar/solarModel.types.ts";

export type SolarForecast = BuiltSolarForecast & {
  fetchedAtMs: number;
  /** "default_mask": no fit for the configured geometry yet — generic horizon instead of the learned shading */
  model: "fitted" | "default_mask";
};

/**
 * PV forecast for the planner from the physical per-string model (backend/src/solar/): open-meteo
 * irradiance through each string's fitted geometry, capacity and shading mask, with a per-string
 * snow nowcast from the last two weeks of production. Cached for an hour by default; callers that
 * need a fresher one (the short-lead accuracy capture) pass maxAgeMs.
 */
export async function fetchSolarForecast(
  tradingConfig: AutomaticTradingConfig,
  influxClient: Influx.InfluxDB | undefined,
  options: { maxAgeMs?: number } = {}
): Promise<SolarForecast> {
  const solarModel = tradingConfig.solar_model;
  const stored = await loadSolarModelState();
  const fit = stored?.fit && fittedGeometryMatches(stored.fit, solarModel) ? stored.fit : undefined;
  const key = JSON.stringify([tradingConfig.latitude, tradingConfig.longitude, solarModel, fit?.fitted_at]);
  const maxAgeMs = options.maxAgeMs ?? CACHE_MAX_AGE_MS;
  if (cache && cache.key === key && Date.now() - cache.value.fetchedAtMs < maxAgeMs) return cache.value;

  const nowMs = Date.now();
  // The nowcast's Influx read runs alongside the open-meteo fetch and can only ever be skipped, never wait long
  const [radiationResult, recentActual] = await Promise.all([
    fetchLiveRadiation(tradingConfig.latitude, tradingConfig.longitude, {
      pastDays: NOWCAST_HISTORY_DAYS,
      forecastDays: FORECAST_DAYS,
    }).then(
      hours => ({ hours }),
      (error: unknown) => ({ error })
    ),
    solarModel.snow_nowcast ? recentStringProduction(influxClient, nowMs, solarModel.rewired_at) : undefined,
  ]);
  if ("error" in radiationResult) {
    if (cache && cache.key === key) {
      warnLog(
        "Solar forecast fetch failed, using stale cache from",
        new Date(cache.value.fetchedAtMs).toISOString(),
        radiationResult.error
      );
      return cache.value;
    }
    throw radiationResult.error;
  }
  if (!fit) {
    warnLog(
      "Solar forecast: no fitted model for the configured geometry yet — using the default horizon mask and 75 % of nameplate until the first refit"
    );
  }
  const geometries = stringGeometries(solarModel);
  const strings = {} as Parameters<typeof buildSolarForecast>[0]["strings"];
  for (const stringKey of SOLAR_STRING_KEYS) {
    strings[stringKey] = {
      tilt_degrees: geometries[stringKey].tilt_degrees,
      azimuth_degrees: geometries[stringKey].azimuth_degrees,
      coefficients: forecastCoefficients(
        fit,
        stringKey,
        solarModel[stringKey].nameplate_kwp,
        geometries[stringKey].ceiling_watts
      ),
    };
  }
  const built = buildSolarForecast({
    radiationHours: radiationResult.hours,
    nowMs,
    latitude: tradingConfig.latitude,
    longitude: tradingConfig.longitude,
    strings,
    recentActual,
  });
  const value: SolarForecast = { ...built, fetchedAtMs: nowMs, model: fit ? "fitted" : "default_mask" };
  cache = { key, value };
  logForecast(built, nowMs);
  return value;
}

let cache: { key: string; value: SolarForecast } | undefined;
const CACHE_MAX_AGE_MS = 60 * 60 * 1000;
/** Two weeks: deep-winter days give the nowcast only a few informative hours each */
const NOWCAST_HISTORY_DAYS = 14;
const FORECAST_DAYS = 4;
/** Unfitted stand-in capacity: the fitted forecast k came out at 72–84 % of nameplate */
const UNFITTED_CAPACITY_SHARE = 0.75;
/** The nowcast is optional: a slow Influx must not hold up the planner (same budget as the tank-temperature read) */
const NOWCAST_QUERY_TIMEOUT_MS = 15_000;

function forecastCoefficients(
  fit: SolarModelFit | undefined,
  stringKey: SolarStringKey,
  nameplateKwp: number,
  ceilingWatts: number
): StringCoefficients {
  const stringFit = fit?.strings[stringKey];
  if (!stringFit) {
    return {
      k: nameplateKwp * UNFITTED_CAPACITY_SHARE,
      sky_factor: 1,
      mask: defaultHorizonMask(),
      ceiling_watts: ceilingWatts,
    };
  }
  return {
    k: stringFit.forecast_k * stringFit.level_multiplier,
    sky_factor: stringFit.forecast_sky_factor,
    mask: stringFit.mask,
    ceiling_watts: ceilingWatts,
  };
}

/** Without recent production the nowcast stays neutral (factor 1) — never a reason to fail the forecast */
async function recentStringProduction(
  influxClient: Influx.InfluxDB | undefined,
  nowMs: number,
  rewiredAt: string
): Promise<Map<number, Record<SolarStringKey, number>> | undefined> {
  if (!influxClient) return undefined;
  try {
    return await queryHourlyStringWatts(
      influxClientQuery(influxClient),
      nowMs - NOWCAST_HISTORY_DAYS * 86_400_000,
      nowMs,
      rewiredAt ? Date.parse(rewiredAt) : Number.NaN,
      NOWCAST_QUERY_TIMEOUT_MS
    );
  } catch (error) {
    warnLog("Solar forecast: recent production unavailable, snow nowcast off for this forecast", error);
    return undefined;
  }
}

function logForecast(built: BuiltSolarForecast, nowMs: number) {
  const snowNotes = SOLAR_STRING_KEYS.filter(stringKey => built.nowcast[stringKey].gateOpen).map(
    stringKey => `${stringKey} snow nowcast ×${built.nowcast[stringKey].ratio.toFixed(2)}`
  );
  logLog(
    "Fetched solar forecast, daily kWh estimates:",
    Object.entries(built.dailyKwh)
      .filter(([day]) => day >= new Date(nowMs).toISOString().slice(0, 10))
      .map(([day, kwh]) => `${day}: ${kwh.toFixed(0)}`)
      .join(", "),
    snowNotes.length ? `(${snowNotes.join(", ")})` : ""
  );
}
