import { warnLog } from "../utilities/logging.ts";
import { describeError } from "../solar/errorDescription.ts";
import { fetchOpenMeteoJson, OPEN_METEO_FORECAST_API } from "../solar/openMeteoClient.ts";
import { OUTLOOK_TEMPERATURE_POINTS, OUTLOOK_WIND_POINTS } from "./priceOutlookCoefficients.ts";
import type {
  HourlyWeatherSample,
  OutlookTemperaturePointName,
  OutlookWeather,
  OutlookWindPointName,
} from "./priceOutlook.types.ts";

/**
 * The latest open-meteo forecast for the price outlook: one call for all wind sites and cities,
 * hourly 100 m wind and 2 m temperature from today's Stockholm midnight for 8 days (the outlook
 * needs D+1…D+6). Shares the solar forecast's fetch: 60 s timeout, one retry after a pause.
 * Undefined, with a warning, when open-meteo fails — the outlook is an optional input and the
 * caller falls back to its other price source.
 */
export async function fetchOutlookWeather(nowMs: number): Promise<OutlookWeather | undefined> {
  try {
    return await requireOutlookWeather(nowMs);
  } catch (error) {
    warnLog(`Price outlook: ${describeError(error)}, no outlook this time`);
    return undefined;
  }
}

/**
 * The same forecast, or an Error saying why there is none, for a caller that reports the failure
 * itself (the planner's weather cache warns once per failing streak and quotes it in plan notes)
 */
export async function requireOutlookWeather(nowMs: number): Promise<OutlookWeather> {
  let payload: unknown;
  try {
    payload = await fetchOpenMeteoJson(`${OPEN_METEO_FORECAST_API}?${outlookForecastParams()}`);
  } catch (error) {
    // The request URL (all 11 coordinates) would bury the reason in a plan note
    throw new Error(`open-meteo weather fetch failed (${withoutTrailingUrl(describeError(error))})`);
  }
  try {
    return parseOutlookWeather(payload, nowMs);
  } catch (error) {
    throw new Error(`unusable open-meteo weather response (${describeError(error)})`);
  }
}

/**
 * Maps open-meteo's multi-location reply (one entry per requested point, in request order) onto the
 * outlook's sites. Throws on any shape it doesn't expect: a mis-mapped site would silently skew
 * the prediction.
 */
export function parseOutlookWeather(payload: unknown, fetchedAtMs: number): OutlookWeather {
  if (!Array.isArray(payload) || payload.length !== REQUEST_POINT_NAMES.length) {
    throw new Error(
      `expected one entry per point (${REQUEST_POINT_NAMES.length}), got ${JSON.stringify(payload).slice(0, 200)}`
    );
  }
  const windSpeedByPoint = {} as Record<OutlookWindPointName, HourlyWeatherSample[]>;
  const temperatureByPoint = {} as Record<OutlookTemperaturePointName, HourlyWeatherSample[]>;
  for (const pointName of WIND_POINT_NAMES) {
    const index = REQUEST_POINT_NAMES.indexOf(pointName);
    windSpeedByPoint[pointName] = pointSamples(payload[index], index, WIND_VARIABLE);
  }
  for (const pointName of TEMPERATURE_POINT_NAMES) {
    const index = REQUEST_POINT_NAMES.indexOf(pointName);
    temperatureByPoint[pointName] = pointSamples(payload[index], index, TEMPERATURE_VARIABLE);
  }
  return { fetchedAtMs, windSpeedByPoint, temperatureByPoint };
}

const WIND_VARIABLE = "wind_speed_100m";
const TEMPERATURE_VARIABLE = "temperature_2m";
/** Today…today+7, as in the study's live request: an outlook issued today needs up to today+6 */
const FORECAST_DAYS = 8;
const WIND_POINT_NAMES = Object.keys(OUTLOOK_WIND_POINTS) as OutlookWindPointName[];
const TEMPERATURE_POINT_NAMES = Object.keys(OUTLOOK_TEMPERATURE_POINTS) as OutlookTemperaturePointName[];
const REQUEST_POINT_NAMES: (OutlookWindPointName | OutlookTemperaturePointName)[] = [
  ...WIND_POINT_NAMES,
  ...TEMPERATURE_POINT_NAMES,
];

/**
 * The study's live request (live_now.py) with unix timestamps: the timezone still starts the series
 * at Stockholm midnight, while instants rather than local labels keep the day bucketing right across
 * a DST switch (open-meteo labels a whole response with one UTC offset).
 */
function outlookForecastParams(): URLSearchParams {
  const coordinates = [
    ...WIND_POINT_NAMES.map(pointName => OUTLOOK_WIND_POINTS[pointName]),
    ...TEMPERATURE_POINT_NAMES.map(pointName => OUTLOOK_TEMPERATURE_POINTS[pointName]),
  ];
  return new URLSearchParams({
    latitude: coordinates.map(point => point.latitude).join(","),
    longitude: coordinates.map(point => point.longitude).join(","),
    hourly: `${WIND_VARIABLE},${TEMPERATURE_VARIABLE}`,
    forecast_days: String(FORECAST_DAYS),
    wind_speed_unit: "ms",
    timezone: "Europe/Stockholm",
    timeformat: "unixtime",
  });
}

function pointSamples(entry: unknown, index: number, variable: string): HourlyWeatherSample[] {
  if (!isRecord(entry) || !isRecord(entry.hourly)) {
    throw new Error(`point ${index} (${REQUEST_POINT_NAMES[index]}) has no hourly section`);
  }
  // open-meteo numbers multi-location replies, all but the first entry (which it sends without a
  // location_id): requiring the ids keeps a reordered or unnumbered reply from swapping two sites
  const locationIdMatches = entry.location_id === index || (index === 0 && entry.location_id === undefined);
  if (!locationIdMatches) {
    throw new Error(`point ${index} (${REQUEST_POINT_NAMES[index]}) came back as location_id ${entry.location_id}`);
  }
  const times = entry.hourly.time;
  const values = entry.hourly[variable];
  if (!isUnixSecondsArray(times)) {
    throw new Error(`point ${index} (${REQUEST_POINT_NAMES[index]}) has no unix hourly.time`);
  }
  if (!isNullableNumberArray(values) || values.length !== times.length) {
    throw new Error(`point ${index} (${REQUEST_POINT_NAMES[index]}) has no usable hourly.${variable}`);
  }
  const samples: HourlyWeatherSample[] = [];
  times.forEach((unixSeconds, hourIndex) => {
    const value = values[hourIndex];
    if (value !== null) samples.push({ atMs: unixSeconds * 1000, value });
  });
  return samples;
}

/** fetchOpenMeteoJson ends its message with ": <url>" */
function withoutTrailingUrl(message: string): string {
  return message.replace(/: https?:\/\/\S+$/, "");
}

function isUnixSecondsArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(entry => Number.isInteger(entry));
}

function isNullableNumberArray(value: unknown): value is (number | null)[] {
  return Array.isArray(value) && value.every(entry => entry === null || typeof entry === "number");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
