/**
 * Daily mean spot prices of past days, for the trailing expected spot (expectedSpot.ts). A published day
 * never changes, so each one is fetched once and kept in memory: a plan only fetches the days it hasn't
 * seen yet (one new day per day). A failed fetch isn't cached. A later plan retries it, but not within
 * the retry interval after a failure: the guard re-builds the planner input every tick under the schedule
 * lock, and a hanging price API must not hold that up each time.
 */
import { warnLog } from "../utilities/logging.ts";
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

/** Mean spot per `${area} ${date}` */
const dailyMeanByAreaAndDate = new Map<string, number>();
/** The last failed fetch per area: what failed, and when */
const lastFailureByArea = new Map<string, { atMs: number; reason: string }>();

/**
 * Main: each date's mean spot, in the order asked for. `failure` says why when any date is missing; the
 * means of the dates it did get are still returned (and cached).
 */
export async function dailyMeanSpots(request: DailyMeanSpotsRequest): Promise<{
  means: DailyMeanSpot[];
  failure: string | undefined;
}> {
  const { area, dates, nowMs, retryAfterFailureMs, fetchDaySlots } = request;
  const uncachedDates = dates.filter(date => !dailyMeanByAreaAndDate.has(cacheKey(area, date)));
  let failure: string | undefined;
  if (uncachedDates.length) {
    const lastFailure = lastFailureByArea.get(area);
    if (lastFailure && nowMs - lastFailure.atMs < retryAfterFailureMs) {
      failure = `${lastFailure.reason} (retrying after ${new Date(lastFailure.atMs + retryAfterFailureMs).toISOString()})`;
    } else {
      const fetched = await Promise.all(uncachedDates.map(date => fetchDailyMean(area, date, fetchDaySlots)));
      const failedDays = fetched.flatMap(day => ("error" in day ? [`${day.date}: ${day.error}`] : []));
      for (const day of fetched) {
        if ("meanSpot" in day) dailyMeanByAreaAndDate.set(cacheKey(area, day.date), day.meanSpot);
      }
      if (failedDays.length) {
        failure = `no ${area} prices for ${failedDays.join("; ")}`;
        lastFailureByArea.set(area, { atMs: nowMs, reason: failure });
        warnLog(`Price history: ${failure} — planning without a terminal value until they are fetched`);
      } else {
        lastFailureByArea.delete(area);
      }
    }
  }
  const means = dates.flatMap(date => {
    const meanSpot = dailyMeanByAreaAndDate.get(cacheKey(area, date));
    return meanSpot === undefined ? [] : [{ date, meanSpot }];
  });
  return { means, failure };
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
    // Reported by dailyMeanSpots' warning and the plan notes; the plan goes ahead without a terminal value
    return { date, error: String(error) };
  }
}

function cacheKey(area: string, date: string): string {
  return `${area} ${date}`;
}
