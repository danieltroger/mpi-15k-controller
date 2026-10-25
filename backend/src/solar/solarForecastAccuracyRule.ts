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
 * The week alert as an explicit episode, carried forward on every daily point: it opens when two
 * evaluations in a row alarm, stays open through further alarming days — and through days whose
 * settlement is missing, since `previous` is the latest settled day — and closes only after
 * RE_ARM_AFTER_CLEAR_DAYS clear days in a row. Whether it has pushed is part of the episode: a
 * day settled late (backfill, no alerting) can open it silently, and the next alerting run still
 * pushes once. Only an episode that pushed gets the quiet resolve.
 */
export function advanceWeekAlertEpisode(input: {
  alarm: boolean;
  /** This run may push (the scheduled settlement of yesterday, with the P2 enabled) */
  alerting: boolean;
  previous: { alarm: boolean; episode_open: boolean; clear_days: number; pushed: boolean } | undefined;
}): { episode_open: boolean; clear_days: number; pushed: boolean; decision: "push" | "resolve" | "none" } {
  const previous = input.previous;
  let episodeOpen: boolean;
  let clearDays = 0;
  let pushed = false;
  if (!previous?.episode_open) {
    episodeOpen = input.alarm && !!previous?.alarm;
  } else if (input.alarm) {
    episodeOpen = true;
    pushed = previous.pushed;
  } else {
    clearDays = previous.clear_days + 1;
    episodeOpen = clearDays < RE_ARM_AFTER_CLEAR_DAYS;
    pushed = previous.pushed;
  }
  if (episodeOpen && !pushed && input.alerting) {
    return { episode_open: true, clear_days: clearDays, pushed: true, decision: "push" };
  }
  if (!episodeOpen) {
    const resolved = !!previous?.episode_open && !!previous.pushed && input.alerting;
    return { episode_open: false, clear_days: 0, pushed: false, decision: resolved ? "resolve" : "none" };
  }
  return { episode_open: true, clear_days: clearDays, pushed, decision: "none" };
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
