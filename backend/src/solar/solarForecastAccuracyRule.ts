import type { AlertingConfig } from "../config/config.types.ts";

/**
 * The rolling-week accuracy verdict (pure). Over the last 7 valid days of day-ahead forecasts:
 * alarm when the week's actual/forecast ratio leaves [min_ratio, max_ratio] (only for weeks that
 * forecast ≥ 70 kWh — dark weeks are all noise), or when the summed daily misses exceed
 * max_error_share of the week's forecast (floored at 35 kWh). Defaults from the 26-month backtest:
 * p1/p99 of the weekly ratio were 0.80/1.38 and of the error share 0.04/0.49.
 */
export function judgeForecastWeek(
  days: DailyForecastAccuracy[],
  alerting: Pick<
    AlertingConfig,
    "solar_forecast_week_min_ratio" | "solar_forecast_week_max_ratio" | "solar_forecast_week_max_error_share"
  >
): ForecastWeekVerdict | undefined {
  const week = days.slice(-WEEK_DAYS);
  if (week.length < MIN_VALID_DAYS) return undefined;
  const forecastKwh = week.reduce((sum, day) => sum + day.forecast_kwh, 0);
  const actualKwh = week.reduce((sum, day) => sum + day.actual_kwh, 0);
  const missedKwh = week.reduce((sum, day) => sum + Math.abs(day.actual_kwh - day.forecast_kwh), 0);
  const ratio = forecastKwh > 0 ? actualKwh / forecastKwh : Number.NaN;
  const errorShare = missedKwh / Math.max(forecastKwh, MIN_ERROR_SHARE_BASE_KWH);
  const ratioOff =
    forecastKwh >= MIN_RATIO_WEEK_KWH &&
    (ratio < alerting.solar_forecast_week_min_ratio || ratio > alerting.solar_forecast_week_max_ratio);
  return {
    alarm: ratioOff || errorShare > alerting.solar_forecast_week_max_error_share,
    days: week.length,
    forecast_kwh: forecastKwh,
    actual_kwh: actualKwh,
    ratio,
    error_share: errorShare,
  };
}

/**
 * Edge-triggered: push once when the alarm has held for two evaluations (today and yesterday, but
 * not the day before), then stay quiet for the rest of the episode; a quiet resolve notice once it
 * clears after having pushed. The rolling 7-day window keeps alarming for days after a bad week —
 * level-triggered, that was up to ~6 identical P2s per episode.
 */
export function decideWeekAlert(alarms: {
  today: boolean;
  yesterday: boolean;
  dayBefore: boolean;
}): "push" | "resolve" | "none" {
  if (alarms.today && alarms.yesterday && !alarms.dayBefore) return "push";
  if (!alarms.today && alarms.yesterday && alarms.dayBefore) return "resolve";
  return "none";
}

export type DailyForecastAccuracy = { date: string; actual_kwh: number; forecast_kwh: number };

export type ForecastWeekVerdict = {
  alarm: boolean;
  days: number;
  forecast_kwh: number;
  actual_kwh: number;
  ratio: number;
  error_share: number;
};

const WEEK_DAYS = 7;
const MIN_VALID_DAYS = 5;
const MIN_RATIO_WEEK_KWH = 70;
const MIN_ERROR_SHARE_BASE_KWH = 35;
