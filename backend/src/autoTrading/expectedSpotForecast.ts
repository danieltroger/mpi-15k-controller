/**
 * p̂ for terminal_value_mode "forecast": the SE3 price outlook's predicted mean spot of D+2…D+4 from the
 * weather forecast (priceOutlook.ts), held within terminal_value_forecast_max_deviation_sek of the trailing
 * estimate. The trailing estimate stands in, with the reason in the plan note, whenever the outlook can't be
 * had: another price area, an issue day outside the fitted October–March, no D+1 prices, a day missing from
 * the 30-day price history, no weather forecast younger than terminal_value_forecast_max_age_hours, or inputs
 * that take longer than terminal_value_forecast_wait_seconds. Each switch to a fallback (or between reasons)
 * is warned about once, the way back logged.
 *
 * Runs before the schedule lock (planRun.ts) on a pi whose CPU is often pegged, so the plan never waits
 * longer than the wait budget for it: a fetch still running then carries on and caches what it gets for
 * the next plan. Past days' prices come from priceHistory.ts's cache (shared with the trailing estimate, one
 * new day per day), today's and tomorrow's from the plan's own prices.
 */
import { logLog, warnLog } from "../utilities/logging.ts";
import { settleWithin } from "../utilities/settleWithin.ts";
import { describeError } from "../solar/errorDescription.ts";
import { addDays, stockholmDateOf } from "../utilities/stockholmDate.ts";
import { type DailyMeanSpotsRequest, dailyMeanSpots } from "./priceHistory.ts";
import { fetchPriceSlotsForDate } from "./priceService.ts";
import { predictDailyMeanSpots } from "./priceOutlook.ts";
import { isOutlookAvailableForArea, isOutlookFittedForIssueDate } from "./priceOutlookCoefficients.ts";
import {
  dailyMeanSpotsOfSlots,
  outlookIssueDate,
  trailing30DayMeanSpot,
  trailingWindowDates,
} from "./priceOutlookInputs.ts";
import { requireOutlookWeather } from "./priceOutlookWeather.ts";
import {
  LIVE_OUTLOOK_WEATHER_CACHE,
  type OutlookWeatherCache,
  type OutlookWeatherResult,
  outlookWeatherNoOlderThan,
} from "./priceOutlookWeatherCache.ts";
import { fallbackSpotEstimate, forecastSpotEstimate } from "./expectedSpotForecastEstimate.ts";
import type { ExpectedSpotRequest, ExpectedSpotSettings } from "./expectedSpot.ts";
import type { ExpectedSpotEstimate } from "./planner.types.ts";
import type { OutlookWeather } from "./priceOutlook.types.ts";

/** Why the outlook wasn't used; a change of kind is what gets warned about */
type FallbackKind =
  | "area"
  | "season"
  | "no_trailing_anchor"
  | "day_ahead_prices"
  | "weather"
  | "weather_late"
  | "price_history"
  | "price_history_late"
  | "prediction";

/** Where the outlook's inputs come from and the state kept between plans; the selftest passes its own */
export type ForecastSources = {
  fetchDaySlots: DailyMeanSpotsRequest["fetchDaySlots"];
  fetchWeather: (nowMs: number) => Promise<OutlookWeather>;
  weatherCache: OutlookWeatherCache;
  /** The last plan's fallback kind, undefined while the outlook was used */
  transitions: { lastFallbackKind: FallbackKind | undefined };
};

const LIVE_SOURCES: ForecastSources = {
  fetchDaySlots: fetchPriceSlotsForDate,
  fetchWeather: requireOutlookWeather,
  weatherCache: LIVE_OUTLOOK_WEATHER_CACHE,
  transitions: { lastFallbackKind: undefined },
};

type ForecastOutcome = { estimate: ExpectedSpotEstimate; fallbackKind?: FallbackKind };

/** Main: the forecast estimate, or the trailing one (already estimated by the caller) standing in */
export async function forecastMeanSpot(
  settings: ExpectedSpotSettings,
  request: ExpectedSpotRequest,
  trailing: ExpectedSpotEstimate,
  sources: ForecastSources = LIVE_SOURCES
): Promise<ExpectedSpotEstimate> {
  const outcome = await outlookOutcome(settings, request, trailing, sources);
  reportTransition(sources.transitions, outcome, trailing);
  return outcome.estimate;
}

async function outlookOutcome(
  settings: ExpectedSpotSettings,
  request: ExpectedSpotRequest,
  trailing: ExpectedSpotEstimate,
  sources: ForecastSources
): Promise<ForecastOutcome> {
  const { nowMs, publishedSlots } = request;
  const area = settings.price_area;
  if (!isOutlookAvailableForArea(area)) {
    return fallback(trailing, "area", `its model is fitted to SE3 prices, not ${area}`);
  }
  // Whether tomorrow is published comes from the slots themselves: a price cache fetched before midnight
  // still says "covers tomorrow" about what is today by now
  const today = stockholmDateOf(nowMs);
  const pricedDayMeans = dailyMeanSpotsOfSlots(publishedSlots);
  const issueDate = outlookIssueDate(today, pricedDayMeans.has(addDays(today, 1)));
  if (!isOutlookFittedForIssueDate(issueDate)) {
    return fallback(trailing, "season", `its model is fitted to October–March issue days, not ${issueDate}`);
  }
  if (trailing.expectedSpot === undefined) {
    return fallback(trailing, "no_trailing_anchor", "it is only used near the trailing mean, which is missing");
  }
  const dayAheadDate = addDays(issueDate, 1);
  const dayAheadMeanSpot = pricedDayMeans.get(dayAheadDate);
  if (dayAheadMeanSpot === undefined) {
    return fallback(trailing, "day_ahead_prices", `no ${area} prices for D+1 (${dayAheadDate})`);
  }

  const waitMs = settings.terminal_value_forecast_wait_seconds * 1000;
  const retryAfterFailureMs = Math.max(2, settings.replan_retry_minutes) * 60_000;
  const historyDates = trailingWindowDates(issueDate).filter(date => !pricedDayMeans.has(date));
  // Both start now, so each gets the same wait. Neither may reject: past the wait nothing awaits them, and an
  // unhandled rejection would take the whole controller down
  const [weatherWait, historyWait] = await Promise.all([
    settleWithin(
      weatherNeverRejects(
        outlookWeatherNoOlderThan(sources.weatherCache, {
          nowMs,
          maxAgeMs: settings.terminal_value_forecast_max_age_hours * 3600_000,
          retryAfterFailureMs,
          fetchWeather: sources.fetchWeather,
        })
      ),
      waitMs
    ),
    settleWithin(
      historyNeverRejects(
        dailyMeanSpots({ area, dates: historyDates, nowMs, retryAfterFailureMs, fetchDaySlots: sources.fetchDaySlots })
      ),
      waitMs
    ),
  ]);
  const waitedSeconds = settings.terminal_value_forecast_wait_seconds;
  if (!weatherWait.settled) {
    return fallback(
      trailing,
      "weather_late",
      `no weather forecast within ${waitedSeconds} s, still fetching for the next plan`
    );
  }
  const weather: OutlookWeatherResult = weatherWait.value;
  if (!weather.weather) return fallback(trailing, "weather", weather.problem);
  if (!historyWait.settled) {
    return fallback(
      trailing,
      "price_history_late",
      `the 30-day price history took over ${waitedSeconds} s, still fetching for the next plan`
    );
  }
  const history = historyWait.value;
  const dailyMeans = new Map<string, number>(history.means.map(day => [day.date, day.meanSpot]));
  for (const [date, meanSpot] of pricedDayMeans) dailyMeans.set(date, meanSpot);
  const trailingMean = trailing30DayMeanSpot(issueDate, dailyMeans);
  if (!trailingMean.available) {
    // The model's pull is fitted on the full 30 days; the missing ones are retried by later plans
    return fallback(
      trailing,
      "price_history",
      `the 30-day price history lacks ${trailingMean.missingDates.length} day(s): ${history.failure ?? trailingMean.missingDates.join(", ")}`
    );
  }
  const prediction = predictDailyMeanSpots({
    weather: weather.weather,
    issueDate,
    dayAheadMeanSpot,
    trailing30DayMeanSpot: trailingMean.meanSpot,
  });
  if (!prediction.available) return fallback(trailing, "prediction", prediction.reason);
  return {
    estimate: forecastSpotEstimate({
      outlook: prediction.outlook,
      trailing: { ...trailing, expectedSpot: trailing.expectedSpot },
      maxDeviationSek: settings.terminal_value_forecast_max_deviation_sek,
      weatherFetchedAtMs: weather.weather.fetchedAtMs,
    }),
  };
}

/** The cache reports failures as a problem; a rejection is a bug in it, warned about and treated as no forecast */
function weatherNeverRejects(lookup: Promise<OutlookWeatherResult>): Promise<OutlookWeatherResult> {
  return lookup.catch((error: unknown) => {
    warnLog("Expected spot: the weather cache threw — planning as without a forecast", error);
    return { problem: `the weather cache threw: ${describeError(error)}` };
  });
}

/** dailyMeanSpots reports failed days as values; a rejection is a bug in it, warned about and treated as no history */
function historyNeverRejects(lookup: ReturnType<typeof dailyMeanSpots>): ReturnType<typeof dailyMeanSpots> {
  return lookup.catch((error: unknown) => {
    warnLog("Expected spot: the price history lookup threw — planning as without the 30-day history", error);
    return { means: [], failure: `the price history lookup threw: ${describeError(error)}` };
  });
}

function fallback(trailing: ExpectedSpotEstimate, fallbackKind: FallbackKind, reason: string): ForecastOutcome {
  return { estimate: fallbackSpotEstimate(trailing, reason), fallbackKind };
}

/** Once per switch: into a fallback, from one reason to another, and back to the outlook */
function reportTransition(
  transitions: ForecastSources["transitions"],
  outcome: ForecastOutcome,
  trailing: ExpectedSpotEstimate
) {
  if (outcome.fallbackKind === transitions.lastFallbackKind) return;
  const forecast = outcome.estimate.forecast;
  if (forecast && !forecast.used) {
    warnLog(
      `Expected spot: the price outlook is unavailable (${forecast.fallbackReason}) — plans use ${trailing.expectedSpot === undefined ? "no terminal value" : `the ${trailing.detail}`} until it is back`
    );
  } else {
    logLog(
      `Expected spot: using the price outlook again (${outcome.estimate.detail} ${outcome.estimate.expectedSpot?.toFixed(2)})`
    );
  }
  transitions.lastFallbackKind = outcome.fallbackKind;
}
