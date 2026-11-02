import { addDays, stockholmDateOf } from "../utilities/stockholmDate.ts";
import { isNonWorkingDay } from "./priceOutlookCalendar.ts";
import {
  isOutlookFittedForIssueDate,
  OUTLOOK_LOG_PRICE_FLOOR,
  OUTLOOK_LOG_PRICE_OFFSET,
  OUTLOOK_TEMPERATURE_POINTS,
  OUTLOOK_WIND_POINTS,
  SE3_OUTLOOK_COEFFICIENTS,
  TURBINE_CUT_IN_MS,
  TURBINE_CUT_OUT_MS,
  TURBINE_RATED_MS,
  type OutlookWindPoint,
} from "./priceOutlookCoefficients.ts";
import type {
  HourlyWeatherSample,
  OutlookDay,
  OutlookDayWeather,
  OutlookLeadDays,
  OutlookTemperaturePointName,
  OutlookWeather,
  OutlookWindPointName,
  PriceOutlookResult,
} from "./priceOutlook.types.ts";

/**
 * Predicted SE3 daily mean spot for D+2…D+6, 2–6 days past the published day-ahead horizon, from the
 * weather forecast (see priceOutlookCoefficients.ts for the model and its out-of-sample skill). Each
 * day starts from the known D+1 mean and moves with the forecast change in wind output, temperature
 * and working-day status from D+1 to that day, plus a pull toward the trailing 30-day mean.
 *
 * Pure: the caller owns the price history and passes the two means in (priceOutlookInputs.ts derives
 * the issue date and the trailing mean); days are Europe/Stockholm calendar days. Unavailable (with
 * the reason) rather than a guess when the weather doesn't cover D+1…D+6 or a price is missing. An
 * issue date outside the fitted October–March still predicts, flagged by withinFittedSeason.
 */
export function predictDailyMeanSpots(input: {
  weather: OutlookWeather;
  /** YYYY-MM-DD, Europe/Stockholm: the day whose day-ahead auction published D+1 */
  issueDate: string;
  /** Mean of D+1's spot slots, SEK/kWh */
  dayAheadMeanSpot: number;
  /** Mean of the 30 daily means D−28…D+1, SEK/kWh */
  trailing30DayMeanSpot: number;
}): PriceOutlookResult {
  const { issueDate, dayAheadMeanSpot, trailing30DayMeanSpot } = input;
  if (!Number.isFinite(dayAheadMeanSpot) || !Number.isFinite(trailing30DayMeanSpot)) {
    return {
      available: false,
      reason: `price input missing (D+1 mean ${dayAheadMeanSpot}, trailing 30-day mean ${trailing30DayMeanSpot})`,
    };
  }
  const weatherByDate = dailyOutlookWeather(input.weather);
  const dayAheadDate = addDays(issueDate, 1);
  const dayAheadWeather = weatherByDate.get(dayAheadDate);
  if (!dayAheadWeather) return { available: false, reason: missingWeatherReason(dayAheadDate, 1) };

  const dayAheadLogSpot = toLogSpot(dayAheadMeanSpot);
  const trailingGap = toLogSpot(trailing30DayMeanSpot) - dayAheadLogSpot;
  const days: OutlookDay[] = [];
  for (const leadDays of OUTLOOK_LEAD_DAYS) {
    const date = addDays(issueDate, leadDays);
    const targetWeather = weatherByDate.get(date);
    if (!targetWeather) return { available: false, reason: missingWeatherReason(date, leadDays) };
    const coefficients = SE3_OUTLOOK_COEFFICIENTS[leadDays];
    const logChange =
      coefficients.intercept +
      coefficients.nordicWindChange *
        (targetWeather.nordicWindCapacityFactor - dayAheadWeather.nordicWindCapacityFactor) +
      coefficients.continentalWindChange *
        (targetWeather.continentalWindCapacityFactor - dayAheadWeather.continentalWindCapacityFactor) +
      coefficients.temperatureChange * (targetWeather.temperatureC - dayAheadWeather.temperatureC) +
      coefficients.nonWorkingChange * (Number(targetWeather.nonWorkingDay) - Number(dayAheadWeather.nonWorkingDay)) +
      coefficients.trailing30DayPull * trailingGap;
    days.push({ ...targetWeather, date, leadDays, predictedMeanSpot: fromLogSpot(dayAheadLogSpot + logChange) });
  }
  const spotsD2toD4 = predictedSpotsUpTo(days, 4);
  return {
    available: true,
    outlook: {
      issueDate,
      withinFittedSeason: isOutlookFittedForIssueDate(issueDate),
      dayAheadMeanSpot,
      trailing30DayMeanSpot,
      dayAheadWeather,
      days,
      meanD2toD4: spotsD2toD4.reduce((sum, spot) => sum + spot, 0) / spotsD2toD4.length,
      maxD2toD5: Math.max(...predictedSpotsUpTo(days, 5)),
    },
  };
}

export const OUTLOOK_LEAD_DAYS: readonly OutlookLeadDays[] = [2, 3, 4, 5, 6];

/** The study averages a day only when it has this many hourly values (DST days have 23 or 25) */
export const MIN_HOURS_PER_DAY = 20;

/**
 * Each Stockholm day's model inputs, for the days every site and city covers with at least
 * MIN_HOURS_PER_DAY hourly values.
 */
export function dailyOutlookWeather(weather: OutlookWeather): Map<string, OutlookDayWeather> {
  const capacityFactorsByPoint = new Map<OutlookWindPointName, Map<string, number>>();
  for (const pointName of WIND_POINT_NAMES) {
    const capacityFactors = weather.windSpeedByPoint[pointName].map(sample => ({
      atMs: sample.atMs,
      value: turbineCapacityFactor(sample.value),
    }));
    capacityFactorsByPoint.set(pointName, completeDailyMeans(capacityFactors));
  }
  const temperaturesByPoint = new Map<OutlookTemperaturePointName, Map<string, number>>();
  for (const pointName of TEMPERATURE_POINT_NAMES) {
    temperaturesByPoint.set(pointName, completeDailyMeans(weather.temperatureByPoint[pointName]));
  }

  const result = new Map<string, OutlookDayWeather>();
  for (const date of capacityFactorsByPoint.get(WIND_POINT_NAMES[0])?.keys() ?? []) {
    const nordicWindCapacityFactor = capacityWeightedMean(capacityFactorsByPoint, "nordic", date);
    const continentalWindCapacityFactor = capacityWeightedMean(capacityFactorsByPoint, "continental", date);
    const temperatureC = cityMeanTemperature(temperaturesByPoint, date);
    if (
      nordicWindCapacityFactor === undefined ||
      continentalWindCapacityFactor === undefined ||
      temperatureC === undefined
    ) {
      continue;
    }
    result.set(date, {
      nordicWindCapacityFactor,
      continentalWindCapacityFactor,
      temperatureC,
      nonWorkingDay: isNonWorkingDay(date),
    });
  }
  return result;
}

/** Mean value and sample count per Europe/Stockholm calendar day */
export function dailyMeansByStockholmDate(
  samples: HourlyWeatherSample[]
): Map<string, { mean: number; sampleCount: number }> {
  const sums = new Map<string, { sum: number; sampleCount: number }>();
  for (const sample of samples) {
    const date = stockholmDateOf(sample.atMs);
    const bucket = sums.get(date) ?? { sum: 0, sampleCount: 0 };
    bucket.sum += sample.value;
    bucket.sampleCount += 1;
    sums.set(date, bucket);
  }
  const means = new Map<string, { mean: number; sampleCount: number }>();
  for (const [date, bucket] of sums) {
    means.set(date, { mean: bucket.sum / bucket.sampleCount, sampleCount: bucket.sampleCount });
  }
  return means;
}

/** Share of rated output a generic turbine makes at this 100 m wind speed (m/s), 0…1 */
export function turbineCapacityFactor(windSpeedMs: number): number {
  if (windSpeedMs < TURBINE_CUT_IN_MS || windSpeedMs >= TURBINE_CUT_OUT_MS) return 0;
  if (windSpeedMs >= TURBINE_RATED_MS) return 1;
  return (windSpeedMs ** 3 - TURBINE_CUT_IN_MS ** 3) / (TURBINE_RATED_MS ** 3 - TURBINE_CUT_IN_MS ** 3);
}

const WIND_POINT_NAMES = Object.keys(OUTLOOK_WIND_POINTS) as OutlookWindPointName[];
const TEMPERATURE_POINT_NAMES = Object.keys(OUTLOOK_TEMPERATURE_POINTS) as OutlookTemperaturePointName[];

function completeDailyMeans(samples: HourlyWeatherSample[]): Map<string, number> {
  const complete = new Map<string, number>();
  for (const [date, { mean, sampleCount }] of dailyMeansByStockholmDate(samples)) {
    if (sampleCount >= MIN_HOURS_PER_DAY) complete.set(date, mean);
  }
  return complete;
}

/** Undefined when any of the region's sites lacks the day */
function capacityWeightedMean(
  capacityFactorsByPoint: Map<OutlookWindPointName, Map<string, number>>,
  region: OutlookWindPoint["region"],
  date: string
): number | undefined {
  let weightedSum = 0;
  let weightSum = 0;
  for (const pointName of WIND_POINT_NAMES) {
    const point = OUTLOOK_WIND_POINTS[pointName];
    if (point.region !== region) continue;
    const capacityFactor = capacityFactorsByPoint.get(pointName)?.get(date);
    if (capacityFactor === undefined) return undefined;
    weightedSum += point.installedGigawatts * capacityFactor;
    weightSum += point.installedGigawatts;
  }
  return weightedSum / weightSum;
}

/** Undefined when any city lacks the day */
function cityMeanTemperature(
  temperaturesByPoint: Map<OutlookTemperaturePointName, Map<string, number>>,
  date: string
): number | undefined {
  let temperatureSum = 0;
  for (const pointName of TEMPERATURE_POINT_NAMES) {
    const temperature = temperaturesByPoint.get(pointName)?.get(date);
    if (temperature === undefined) return undefined;
    temperatureSum += temperature;
  }
  return temperatureSum / TEMPERATURE_POINT_NAMES.length;
}

function toLogSpot(spot: number): number {
  return Math.log(Math.max(spot, OUTLOOK_LOG_PRICE_FLOOR) + OUTLOOK_LOG_PRICE_OFFSET);
}

function fromLogSpot(logSpot: number): number {
  return Math.exp(logSpot) - OUTLOOK_LOG_PRICE_OFFSET;
}

function predictedSpotsUpTo(days: OutlookDay[], lastLeadDays: OutlookLeadDays): number[] {
  return days.filter(day => day.leadDays <= lastLeadDays).map(day => day.predictedMeanSpot);
}

function missingWeatherReason(date: string, leadDays: number): string {
  return `the weather forecast has fewer than ${MIN_HOURS_PER_DAY} hours of some site or city for D+${leadDays} (${date})`;
}
