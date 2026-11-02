/**
 * Daily mean spot prices of past days, for the trailing expected spot (expectedSpot.ts). A published day
 * never changes, so each one is fetched once and kept in memory: a plan only fetches the days it hasn't
 * seen yet (one new day per day), and days older than the longest trailing window are dropped. A failed
 * fetch isn't cached; a later plan retries it, but not within the retry interval after a failure, and each
 * failing day is warned about once (and its recovery logged), not on every retry.
 */
import { logLog, warnLog } from "../utilities/logging.ts";
import { PLANNER_KNOB_BOUNDS } from "./plannerKnobBounds.ts";
import type { PriceSlot15 } from "./planner.types.ts";

export type DailyMeanSpot = { date: string; meanSpot: number };

export type DailyMeanSpotsRequest = {
  area: string;
  /** Past local dates (YYYY-MM-DD) */
  dates: string[];
  nowMs: number;
  /** How long after a failed fetch the missing days aren't fetched again */
  retryAfterFailureMs: number;
  /** One day's 15-min prices, [] when the API has none (priceService.fetchPriceSlotsForDate) */
  fetchDaySlots: (area: string, date: string) => Promise<PriceSlot15[]>;
};

/**
 * At most this many day fetches at once: after a restart a window of up to 60 days is missing, and each is
 * a TLS fetch on a pi whose CPU is often pegged — the conditions behind the connect timeouts plan retries
 * exist for
 */
const MAX_CONCURRENT_DAY_FETCHES = 4;

type AreaHistory = {
  meanByDate: Map<string, number>;
  /** Why each currently failing date failed, warned about once */
  failingDates: Map<string, string>;
  lastFailureAtMs: number | undefined;
};

const historyByArea = new Map<string, AreaHistory>();

/**
 * Main: each date's mean spot that is (or could be fetched) at hand, in the order asked for. `failure` says
 * which dates are missing and why; the caller decides whether the rest are enough.
 */
export async function dailyMeanSpots(request: DailyMeanSpotsRequest): Promise<{
  means: DailyMeanSpot[];
  failure: string | undefined;
}> {
  const { area, dates, nowMs, retryAfterFailureMs, fetchDaySlots } = request;
  const history = areaHistory(area);
  const uncachedDates = dates.filter(date => !history.meanByDate.has(date));
  const retryAtMs = history.lastFailureAtMs === undefined ? undefined : history.lastFailureAtMs + retryAfterFailureMs;
  const inBackoff = retryAtMs !== undefined && nowMs < retryAtMs;
  if (uncachedDates.length && !inBackoff) {
    const fetched = await mapWithConcurrency(uncachedDates, MAX_CONCURRENT_DAY_FETCHES, date =>
      fetchDailyMean(area, date, fetchDaySlots)
    );
    recordFetchedDays(area, history, fetched, nowMs);
  }
  pruneDaysOutsideAnyWindow(history, nowMs);
  const means = dates.flatMap(date => {
    const meanSpot = history.meanByDate.get(date);
    return meanSpot === undefined ? [] : [{ date, meanSpot }];
  });
  const missing = dates.filter(date => !history.meanByDate.has(date));
  if (!missing.length) return { means, failure: undefined };
  const reasons = missing.map(date => `${date}: ${history.failingDates.get(date) ?? "not fetched yet"}`);
  const retry = inBackoff ? ` (retrying after ${new Date(retryAtMs).toISOString()})` : "";
  return { means, failure: `no ${area} prices for ${reasons.join("; ")}${retry}` };
}

function recordFetchedDays(
  area: string,
  history: AreaHistory,
  fetched: (DailyMeanSpot | { date: string; error: string })[],
  nowMs: number
) {
  const newlyFailing: string[] = [];
  for (const day of fetched) {
    if ("meanSpot" in day) {
      history.meanByDate.set(day.date, day.meanSpot);
      if (history.failingDates.delete(day.date)) logLog(`Price history: ${area} ${day.date} fetched after all`);
    } else {
      if (!history.failingDates.has(day.date)) newlyFailing.push(`${day.date}: ${day.error}`);
      history.failingDates.set(day.date, day.error);
    }
  }
  history.lastFailureAtMs = fetched.some(day => "error" in day) ? nowMs : undefined;
  if (newlyFailing.length) {
    warnLog(`Price history: no ${area} prices for ${newlyFailing.join("; ")} — retried by later plans`);
  }
}

/** One day's mean spot (every 15-min slot weighs the same, so a DST day's 23 or 25 hours average right) */
async function fetchDailyMean(
  area: string,
  date: string,
  fetchDaySlots: DailyMeanSpotsRequest["fetchDaySlots"]
): Promise<DailyMeanSpot | { date: string; error: string }> {
  try {
    const slots = await fetchDaySlots(area, date);
    if (!slots.length) return { date, error: "not published" };
    return { date, meanSpot: slots.reduce((sum, slot) => sum + slot.spot, 0) / slots.length };
  } catch (error) {
    // Warned about once per date by recordFetchedDays, and quoted in the plan notes
    return { date, error: String(error) };
  }
}

/** Days no trailing window can still ask for (the longest allowed, plus a day's slack for time zones) */
function pruneDaysOutsideAnyWindow(history: AreaHistory, nowMs: number) {
  const oldestUsefulMs = nowMs - (PLANNER_KNOB_BOUNDS.terminal_value_trailing_days.max + 2) * 24 * 3600_000;
  const oldestUsefulDate = new Date(oldestUsefulMs).toISOString().slice(0, 10);
  for (const date of history.meanByDate.keys()) if (date < oldestUsefulDate) history.meanByDate.delete(date);
  for (const date of history.failingDates.keys()) if (date < oldestUsefulDate) history.failingDates.delete(date);
}

function areaHistory(area: string): AreaHistory {
  let history = historyByArea.get(area);
  if (!history) {
    history = { meanByDate: new Map(), failingDates: new Map(), lastFailureAtMs: undefined };
    historyByArea.set(area, history);
  }
  return history;
}

/** mapItem over every item, at most `limit` at a time, results in the items' order */
async function mapWithConcurrency<Item, Result>(
  items: Item[],
  limit: number,
  mapItem: (item: Item) => Promise<Result>
): Promise<Result[]> {
  const results: Result[] = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const itemIndex = nextIndex++;
      results[itemIndex] = await mapItem(items[itemIndex]);
    }
  });
  await Promise.all(workers);
  return results;
}
