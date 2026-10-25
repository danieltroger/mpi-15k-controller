import type Influx from "influx";
import type { AutomaticTradingConfig } from "../config/config.types.ts";
import { logLog, warnLog } from "../utilities/logging.ts";
import { fetchLiveRadiation } from "../solar/openMeteoClient.ts";
import { queryHourlyStringWatts } from "../solar/pvHistory.ts";
import { defaultHorizonMask, type StringCoefficients } from "../solar/pvModel.ts";
import { buildSolarForecast, SOLAR_STRING_KEYS, type BuiltSolarForecast } from "../solar/solarForecastModel.ts";
import { loadSolarModelState } from "../solar/solarModelStore.ts";
import { fittedGeometryMatches, stringGeometries } from "../solar/solarModelGeometry.ts";
import type { RadiationHour, SolarModelState, SolarStringKey } from "../solar/solarModel.types.ts";

export type SolarForecast = BuiltSolarForecast & {
  fetchedAtMs: number;
  /** "default_mask": no fit for the configured geometry yet — generic horizon instead of the learned shading */
  model: "fitted" | "default_mask";
};

/**
 * PV forecast for the planner from the physical per-string model (backend/src/solar/): open-meteo
 * irradiance through each string's fitted geometry, capacity and shading mask, with a per-string
 * snow nowcast from the last two weeks of production. Cached for an hour.
 */
export async function fetchSolarForecast(
  tradingConfig: AutomaticTradingConfig,
  influxClient: Influx.InfluxDB | undefined
): Promise<SolarForecast> {
  const solarModel = tradingConfig.solar_model;
  const stored = await loadSolarModelState();
  const state = stored && fittedGeometryMatches(stored, solarModel) ? stored : undefined;
  const key = JSON.stringify([tradingConfig.latitude, tradingConfig.longitude, solarModel, state?.fitted_at]);
  if (cache && cache.key === key && Date.now() - cache.value.fetchedAtMs < CACHE_MAX_AGE_MS) return cache.value;

  let radiationHours: RadiationHour[];
  try {
    radiationHours = await fetchLiveRadiation(tradingConfig.latitude, tradingConfig.longitude, {
      pastDays: NOWCAST_HISTORY_DAYS,
      forecastDays: FORECAST_DAYS,
    });
  } catch (error) {
    if (cache && cache.key === key) {
      warnLog(
        "Solar forecast fetch failed, using stale cache from",
        new Date(cache.value.fetchedAtMs).toISOString(),
        error
      );
      return cache.value;
    }
    throw error;
  }
  if (!state) {
    warnLog(
      "Solar forecast: no fitted model for the configured geometry yet — using the default horizon mask and 75 % of nameplate until the first refit"
    );
  }
  const nowMs = Date.now();
  const recentActual = solarModel.snow_nowcast
    ? await recentStringProduction(influxClient, nowMs, solarModel.rewired_at)
    : undefined;
  const geometries = stringGeometries(solarModel);
  const strings = {} as Parameters<typeof buildSolarForecast>[0]["strings"];
  for (const stringKey of SOLAR_STRING_KEYS) {
    strings[stringKey] = {
      tilt_degrees: geometries[stringKey].tilt_degrees,
      azimuth_degrees: geometries[stringKey].azimuth_degrees,
      coefficients: forecastCoefficients(
        state,
        stringKey,
        solarModel[stringKey].nameplate_kwp,
        geometries[stringKey].ceiling_watts
      ),
    };
  }
  const built = buildSolarForecast({
    radiationHours,
    nowMs,
    latitude: tradingConfig.latitude,
    longitude: tradingConfig.longitude,
    strings,
    recentActual,
  });
  const value: SolarForecast = { ...built, fetchedAtMs: nowMs, model: state ? "fitted" : "default_mask" };
  cache = { key, value };
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
  return value;
}

let cache: { key: string; value: SolarForecast } | undefined;
const CACHE_MAX_AGE_MS = 60 * 60 * 1000;
/** Two weeks: deep-winter days give the nowcast only a few informative hours each */
const NOWCAST_HISTORY_DAYS = 14;
const FORECAST_DAYS = 4;
/** Unfitted stand-in capacity: the fitted forecast k came out at 72–84 % of nameplate */
const UNFITTED_CAPACITY_SHARE = 0.75;

function forecastCoefficients(
  state: SolarModelState | undefined,
  stringKey: SolarStringKey,
  nameplateKwp: number,
  ceilingWatts: number
): StringCoefficients {
  const fit = state?.strings[stringKey];
  if (!fit) {
    return {
      k: nameplateKwp * UNFITTED_CAPACITY_SHARE,
      sky_factor: 1,
      mask: defaultHorizonMask(),
      ceiling_watts: ceilingWatts,
    };
  }
  return {
    k: fit.forecast_k * fit.level_multiplier,
    sky_factor: fit.forecast_sky_factor,
    mask: fit.mask,
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
      influxClient,
      nowMs - NOWCAST_HISTORY_DAYS * 86_400_000,
      nowMs,
      rewiredAt ? Date.parse(rewiredAt) : Number.NaN
    );
  } catch (error) {
    warnLog("Solar forecast: recent production unavailable, snow nowcast off for this forecast", error);
    return undefined;
  }
}
