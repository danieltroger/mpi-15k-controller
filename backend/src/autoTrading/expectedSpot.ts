/**
 * p̂, the spot price the planner expects after its priced horizon: the terminal value and the unpriced tail
 * are priced at it (terminalValue.ts). One estimator per ExpectedSpotSource — "trailing" averages recent
 * days; "forecast" takes the SE3 price outlook's predicted D+2…D+4 from the weather forecast
 * (expectedSpotForecast.ts), with the trailing estimate as its anchor and fallback. Runs at plan time on the
 * pi, so it never throws: a failure is an estimate without a value, and the plan runs without a terminal
 * value and says why in its notes.
 */
import type { AutomaticTradingConfig, ExpectedSpotSource } from "../config/config.types.ts";
import { warnLog } from "../utilities/logging.ts";
import { addDays, stockholmDateOf } from "../utilities/stockholmDate.ts";
import { fetchPriceSlotsForDate } from "./priceService.ts";
import { type DailyMeanSpot, dailyMeanSpots } from "./priceHistory.ts";
import { isExpectedSpotSource, terminalValueInSeason } from "./terminalValue.ts";
import { forecastMeanSpot } from "./expectedSpotForecast.ts";
import type { ExpectedSpotEstimate, PlannerKnobs, PriceSlot15 } from "./planner.types.ts";

/** The settings the estimators read: the automatic_trading section with its knobs corrected (plannerKnobs.ts) */
export type ExpectedSpotSettings = Pick<AutomaticTradingConfig, "price_area" | "replan_retry_minutes"> &
  Pick<
    PlannerKnobs,
    | "terminal_value_mode"
    | "terminal_value_months"
    | "terminal_value_trailing_days"
    | "terminal_value_forecast_max_deviation_sek"
    | "terminal_value_forecast_max_age_hours"
    | "terminal_value_forecast_wait_seconds"
  >;

export type ExpectedSpotRequest = {
  nowMs: number;
  /** The plan's own prices (today, and tomorrow once published): the outlook reads their daily means */
  publishedSlots: PriceSlot15[];
};

type ExpectedSpotEstimator = (
  settings: ExpectedSpotSettings,
  request: ExpectedSpotRequest
) => Promise<ExpectedSpotEstimate>;

const ESTIMATORS: Record<ExpectedSpotSource, ExpectedSpotEstimator> = {
  trailing: (settings, request) => trailingMeanSpot(settings, request.nowMs),
  // The trailing estimate as a promise: the forecast starts its weather lookup alongside it
  forecast: (settings, request) => forecastMeanSpot(settings, request, trailingMeanSpot(settings, request.nowMs)),
};

/** Main: p̂ for a plan made at request.nowMs; undefined when the terminal value is off or out of season */
export async function expectedSpotForPlan(
  settings: ExpectedSpotSettings,
  request: ExpectedSpotRequest
): Promise<ExpectedSpotEstimate | undefined> {
  const source = settings.terminal_value_mode;
  if (!isExpectedSpotSource(source) || !terminalValueInSeason(settings, request.nowMs)) return undefined;
  try {
    return await ESTIMATORS[source](settings, request);
  } catch (error) {
    warnLog(`Expected spot (${source}) failed — planning without a terminal value`, error);
    return { expectedSpot: undefined, source, detail: `estimating the expected spot failed: ${String(error)}` };
  }
}

/** The mean daily-mean spot of the last terminal_value_trailing_days complete days (Swedish dates before today) */
async function trailingMeanSpot(settings: ExpectedSpotSettings, nowMs: number): Promise<ExpectedSpotEstimate> {
  const days = Math.round(settings.terminal_value_trailing_days);
  const { means, failure } = await dailyMeanSpots({
    area: settings.price_area,
    dates: completeDaysBefore(nowMs, days),
    nowMs,
    // The price API's retry spacing (also tomorrow's prices' wait), floored like the plan retries
    retryAfterFailureMs: Math.max(2, settings.replan_retry_minutes) * 60_000,
    fetchDaySlots: fetchPriceSlotsForDate,
  });
  return trailingEstimateFromDays(means, days, failure);
}

/**
 * The trailing estimate from the days at hand: the mean of those there are while at least half the window
 * is. A 7-day mean hardly moves without one of its days, while requiring all of them would switch the value
 * off for a whole window over one permanently missing day, and during a price-API outage flip plans between
 * keeping the stock and selling it. Fetched days stay cached, so the days an earlier estimate used remain
 * usable — this doubles as the "last good value" fallback, aged out as its days leave the window.
 */
export function trailingEstimateFromDays(
  means: DailyMeanSpot[],
  days: number,
  failure: string | undefined
): ExpectedSpotEstimate {
  if (means.length < Math.ceil(days / 2)) {
    return {
      expectedSpot: undefined,
      source: "trailing",
      detail: `the ${days}-day mean spot is unavailable, ${means.length} of ${days} days at hand: ${failure}`,
    };
  }
  return {
    expectedSpot: means.reduce((sum, day) => sum + day.meanSpot, 0) / means.length,
    source: "trailing",
    detail: means.length === days ? `${days}-day mean spot` : `${days}-day mean spot (${means.length} of ${days} days)`,
  };
}

/** The `days` Swedish calendar dates (YYYY-MM-DD) before the one nowMs falls on, newest first */
export function completeDaysBefore(nowMs: number, days: number): string[] {
  // Calendar arithmetic on the date itself sidesteps DST's 23/25-hour days
  const today = stockholmDateOf(nowMs);
  return Array.from({ length: days }, (_, daysBack) => addDays(today, -1 - daysBack));
}
