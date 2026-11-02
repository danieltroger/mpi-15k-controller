/**
 * p̂, the spot price the planner expects after its priced horizon: the terminal value and the unpriced tail
 * are priced at it (terminalValue.ts). One estimator per ExpectedSpotSource — "trailing" averages recent
 * days; a weather-based "forecast" source (a pure SE3 daily price outlook) is meant to plug in next to it,
 * returning the same ExpectedSpotEstimate. Runs at plan time on the pi, so it never throws: a failure is an
 * estimate without a value, and the plan runs without a terminal value and says why in its notes.
 */
import type { AutomaticTradingConfig, ExpectedSpotSource } from "../config/config.types.ts";
import { warnLog } from "../utilities/logging.ts";
import { addDays, stockholmDateOf } from "../utilities/stockholmDate.ts";
import { fetchPriceSlotsForDate } from "./priceService.ts";
import { type DailyMeanSpot, dailyMeanSpots } from "./priceHistory.ts";
import { isExpectedSpotSource, terminalValueInSeason } from "./terminalValue.ts";
import type { ExpectedSpotEstimate, PlannerKnobs } from "./planner.types.ts";

/** The settings the estimators read: the automatic_trading section with its knobs corrected (plannerKnobs.ts) */
export type ExpectedSpotSettings = Pick<AutomaticTradingConfig, "price_area" | "replan_retry_minutes"> &
  Pick<PlannerKnobs, "terminal_value_mode" | "terminal_value_months" | "terminal_value_trailing_days">;

type ExpectedSpotEstimator = (settings: ExpectedSpotSettings, nowMs: number) => Promise<ExpectedSpotEstimate>;

const ESTIMATORS: Record<ExpectedSpotSource, ExpectedSpotEstimator> = {
  trailing: trailingMeanSpot,
};

/** Main: p̂ for a plan made at nowMs; undefined when the terminal value is off or out of season */
export async function expectedSpotForPlan(
  settings: ExpectedSpotSettings,
  nowMs: number
): Promise<ExpectedSpotEstimate | undefined> {
  const source = settings.terminal_value_mode;
  if (!isExpectedSpotSource(source) || !terminalValueInSeason(settings, nowMs)) return undefined;
  try {
    return await ESTIMATORS[source](settings, nowMs);
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
