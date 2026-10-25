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
 * The week alert as an explicit episode, carried forward on every daily point: it opens (one
 * push) when two evaluations in a row alarm, stays open through further alarming days — and
 * through days whose settlement is missing, since `previous` is the latest settled day — and only
 * closes (a quiet resolve) after RE_ARM_AFTER_CLEAR_DAYS clear days in a row. Level-triggered,
 * the rolling 7-day window gave up to ~6 identical P2s per episode, and a one-day dip re-pushed.
 */
export function advanceWeekAlertEpisode(input: {
  alarm: boolean;
  previous: { alarm: boolean; episode_open: boolean; clear_days: number } | undefined;
}): { episode_open: boolean; clear_days: number; decision: "push" | "resolve" | "none" } {
  if (!input.previous?.episode_open) {
    return input.alarm && input.previous?.alarm
      ? { episode_open: true, clear_days: 0, decision: "push" }
      : { episode_open: false, clear_days: 0, decision: "none" };
  }
  if (input.alarm) return { episode_open: true, clear_days: 0, decision: "none" };
  const clearDays = input.previous.clear_days + 1;
  return clearDays >= RE_ARM_AFTER_CLEAR_DAYS
    ? { episode_open: false, clear_days: 0, decision: "resolve" }
    : { episode_open: true, clear_days: clearDays, decision: "none" };
}

const RE_ARM_AFTER_CLEAR_DAYS = 3;

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
