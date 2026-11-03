/**
 * p̂ for terminal_value_mode "forecast": the SE3 price outlook's predicted mean spot of D+2…D+4 from the
 * weather forecast (priceOutlook.ts), held within terminal_value_forecast_max_deviation_sek of the trailing
 * estimate. The trailing estimate stands in, with the reason in the plan note, whenever the outlook can't be
 * had: another price area, an issue day outside the fitted October–March, no D+1 prices, a day missing from
 * the 30-day price history, no weather forecast younger than terminal_value_forecast_max_age_hours, inputs
 * that take longer than terminal_value_forecast_wait_seconds, or an unexpected error computing it. Each
 * switch to a fallback (or between reasons) is warned about once, the way back logged.
 *
 * Runs before the schedule lock (planRun.ts) on a pi whose CPU is often pegged, so the plan never waits
 * longer than the wait budget for it: a fetch still running then carries on and caches what it gets for
 * the next plan. Past days' prices come from priceHistory.ts's cache (shared with the trailing estimate, one
 * new day per day; its failure backoff is the outlook's own), today's and tomorrow's from the plan's own prices.
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

/** Why the outlook wasn't used */
type FallbackKind =
  | "area"
  | "season"
  | "no_trailing_anchor"
  | "day_ahead_prices"
  | "weather"
  | "weather_late"
  | "price_history"
  | "price_history_late"
  | "prediction"
  | "error";

/**
 * What a switch is warned about by: a slow open-meteo that then fails alternates between late and failed on
 * every plan (and the history likewise), which is one problem, not a new one each time
 */
const TRANSITION_GROUP: Record<FallbackKind, FallbackKind> = {
  area: "area",
  season: "season",
  no_trailing_anchor: "no_trailing_anchor",
  day_ahead_prices: "day_ahead_prices",
  weather: "weather",
  weather_late: "weather",
  price_history: "price_history",
  price_history_late: "price_history",
  prediction: "prediction",
  error: "error",
};

/** Where the outlook's inputs come from and the state kept between plans; the selftest passes its own */
export type ForecastSources = {
  fetchDaySlots: DailyMeanSpotsRequest["fetchDaySlots"];
  fetchWeather: (nowMs: number) => Promise<OutlookWeather>;
  weatherCache: OutlookWeatherCache;
  /** The last plan's fallback group (TRANSITION_GROUP), undefined while the outlook was used */
  transitions: { lastFallbackGroup: FallbackKind | undefined };
};

const LIVE_SOURCES: ForecastSources = {
  fetchDaySlots: fetchPriceSlotsForDate,
  fetchWeather: requireOutlookWeather,
  weatherCache: LIVE_OUTLOOK_WEATHER_CACHE,
  transitions: { lastFallbackGroup: undefined },
};

/** The outlook's own backoff in priceHistory: its failing days don't hold back the trailing estimate's new day */
const HISTORY_BACKOFF_GROUP = "price outlook";

/** Most missing history days a fallback reason names one by one; past it, the count and the span */
const MAX_MISSING_DAYS_LISTED = 3;

type ForecastOutcome = { estimate: ExpectedSpotEstimate; fallbackKind?: FallbackKind; error?: unknown };

/** The issue day and the plan's own daily means, or why the outlook doesn't apply to this plan at all */
type OutlookSetup =
  | { applies: true; issueDate: string; pricedDayMeans: Map<string, number> }
  | { applies: false; fallbackKind: FallbackKind; reason: string; error?: unknown };

/**
 * Main: the forecast estimate, or the trailing one standing in. The trailing estimate comes in as a promise:
 * the weather lookup doesn't need it, so it starts first and a cold start's open-meteo call overlaps the
 * trailing days' fetch. A rejected trailing estimate rejects (expectedSpotForPlan reports it, as in trailing
 * mode); anything that goes wrong after it is a fallback to it.
 */
export async function forecastMeanSpot(
  settings: ExpectedSpotSettings,
  request: ExpectedSpotRequest,
  trailingEstimate: Promise<ExpectedSpotEstimate>,
  sources: ForecastSources = LIVE_SOURCES
): Promise<ExpectedSpotEstimate> {
  const setup = guardedSetup(settings, request);
  const started = setup.applies ? { ...setup, weatherLookup: lookUpWeather(settings, request.nowMs, sources) } : setup;
  const trailing = await trailingEstimate;
  let outcome: ForecastOutcome;
  try {
    outcome = started.applies
      ? await outlookOutcome(settings, request, { trailing, sources, started })
      : fallbackFromSetup(trailing, started);
  } catch (error) {
    // A bug (a parser or model regression, a malformed forecast): the trailing estimate is in hand, so the
    // plan keeps a terminal value instead of losing it to expectedSpotForPlan's catch
    outcome = { ...fallback(trailing, "error", `computing it failed: ${describeError(error)}`), error };
  }
  reportTransition(sources.transitions, outcome, trailing);
  return outcome.estimate;
}

async function outlookOutcome(
  settings: ExpectedSpotSettings,
  request: ExpectedSpotRequest,
  context: {
    trailing: ExpectedSpotEstimate;
    sources: ForecastSources;
    /** The issue day and the weather lookup already under way */
    started: Extract<OutlookSetup, { applies: true }> & { weatherLookup: Promise<OutlookWeatherResult> };
  }
): Promise<ForecastOutcome> {
  const { trailing, sources } = context;
  const { issueDate, pricedDayMeans, weatherLookup } = context.started;
  const { nowMs } = request;
  const area = settings.price_area;
  if (trailing.expectedSpot === undefined) {
    return fallback(trailing, "no_trailing_anchor", "it is only used near the trailing mean, which is missing");
  }
  const dayAheadDate = addDays(issueDate, 1);
  const dayAheadMeanSpot = pricedDayMeans.get(dayAheadDate);
  if (dayAheadMeanSpot === undefined) {
    return fallback(trailing, "day_ahead_prices", `no ${area} prices for D+1 (${dayAheadDate})`);
  }

  const waitMs = settings.terminal_value_forecast_wait_seconds * 1000;
  const historyDates = trailingWindowDates(issueDate).filter(date => !pricedDayMeans.has(date));
  // Both waits start now (the weather lookup had a head start during the trailing fetch). Neither input may
  // reject: past the wait nothing awaits them, and an unhandled rejection would take the controller down
  const [weatherWait, historyWait] = await Promise.all([
    settleWithin(weatherLookup, waitMs),
    settleWithin(
      historyNeverRejects(
        dailyMeanSpots({
          area,
          dates: historyDates,
          nowMs,
          retryAfterFailureMs: retryAfterFailureMs(settings),
          fetchDaySlots: sources.fetchDaySlots,
          backoffGroup: HISTORY_BACKOFF_GROUP,
        })
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
    return fallback(trailing, "price_history", missingHistoryReason(trailingMean.missingDates, history.failure));
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

/** The area and season gates and the issue day; a throw here is a bug, and a fallback like any later one */
function guardedSetup(settings: ExpectedSpotSettings, request: ExpectedSpotRequest): OutlookSetup {
  try {
    const area = settings.price_area;
    if (!isOutlookAvailableForArea(area)) {
      return { applies: false, fallbackKind: "area", reason: `its model is fitted to SE3 prices, not ${area}` };
    }
    // Whether tomorrow is published comes from the slots themselves: a price cache fetched before midnight
    // still says "covers tomorrow" about what is today by now
    const today = stockholmDateOf(request.nowMs);
    const pricedDayMeans = dailyMeanSpotsOfSlots(request.publishedSlots);
    const issueDate = outlookIssueDate(today, pricedDayMeans.has(addDays(today, 1)));
    if (!isOutlookFittedForIssueDate(issueDate)) {
      return {
        applies: false,
        fallbackKind: "season",
        reason: `its model is fitted to October–March issue days, not ${issueDate}`,
      };
    }
    return { applies: true, issueDate, pricedDayMeans };
  } catch (error) {
    return { applies: false, fallbackKind: "error", reason: `computing it failed: ${describeError(error)}`, error };
  }
}

function lookUpWeather(
  settings: ExpectedSpotSettings,
  nowMs: number,
  sources: ForecastSources
): Promise<OutlookWeatherResult> {
  return weatherNeverRejects(
    outlookWeatherNoOlderThan(sources.weatherCache, {
      nowMs,
      maxAgeMs: settings.terminal_value_forecast_max_age_hours * 3600_000,
      retryAfterFailureMs: retryAfterFailureMs(settings),
      fetchWeather: sources.fetchWeather,
    })
  );
}

/** The price API's retry spacing (also tomorrow's prices' wait), floored like the plan retries */
function retryAfterFailureMs(settings: ExpectedSpotSettings): number {
  return Math.max(2, settings.replan_retry_minutes) * 60_000;
}

/**
 * The 30-day window's missing days for the plan note, the panel and the warning: a few are named with why;
 * after a restart in the history's backoff it is ~22 "not fetched yet", so then the count and the span
 */
export function missingHistoryReason(missingDates: string[], failure: string | undefined): string {
  if (missingDates.length <= MAX_MISSING_DAYS_LISTED) {
    const plural = missingDates.length === 1 ? "day" : "days";
    return `the 30-day price history has ${missingDates.length} ${plural} missing: ${failure ?? missingDates.join(", ")}`;
  }
  return `the 30-day price history has ${missingDates.length} days missing (${missingDates[0]} … ${missingDates[missingDates.length - 1]}), retried by later plans`;
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

function fallbackFromSetup(
  trailing: ExpectedSpotEstimate,
  setup: Extract<OutlookSetup, { applies: false }>
): ForecastOutcome {
  return { ...fallback(trailing, setup.fallbackKind, setup.reason), error: setup.error };
}

/** Once per switch: into a fallback, from one reason to another, and back to the outlook */
function reportTransition(
  transitions: ForecastSources["transitions"],
  outcome: ForecastOutcome,
  trailing: ExpectedSpotEstimate
) {
  const group = outcome.fallbackKind === undefined ? undefined : TRANSITION_GROUP[outcome.fallbackKind];
  if (group === transitions.lastFallbackGroup) return;
  const forecast = outcome.estimate.forecast;
  if (forecast && !forecast.used) {
    const message = `Expected spot: the price outlook is unavailable (${forecast.fallbackReason}) — plans use ${trailing.expectedSpot === undefined ? "no terminal value" : `the ${trailing.detail}`} until it is back`;
    // An unexpected error comes with its stack, once per switch like the rest
    if (outcome.error === undefined) warnLog(message);
    else warnLog(message, outcome.error);
  } else {
    logLog(
      `Expected spot: using the price outlook again (${outcome.estimate.detail} ${outcome.estimate.expectedSpot?.toFixed(2)})`
    );
  }
  transitions.lastFallbackGroup = group;
}
