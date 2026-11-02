import { addDays, stockholmDateOf } from "./priceOutlookCalendar.ts";
import { OUTLOOK_TRAILING_DAYS } from "./priceOutlookCoefficients.ts";
import type { PriceSlot15 } from "./planner.types.ts";

/**
 * The outlook's issue day D on a given Stockholm date. The model's D is a day whose day-ahead auction
 * already published D+1, so it is today once tomorrow's prices are out (~13:00) and yesterday before
 * that. Either way, a forecast fetched today (it starts at today's midnight) covers D+1…D+6.
 */
export function outlookIssueDate(today: string, tomorrowPricesPublished: boolean): string {
  return tomorrowPricesPublished ? today : addDays(today, -1);
}

/** The days whose daily means make up the trailing mean, D−28…D+1, oldest first */
export function trailingWindowDates(issueDate: string): string[] {
  return Array.from({ length: OUTLOOK_TRAILING_DAYS }, (_unused, index) =>
    addDays(issueDate, index - OUTLOOK_TRAILING_DAYS + 2)
  );
}

/**
 * The mean of the trailing window's daily means, or the window's days that have none. All 30 are
 * required, as in the study: a mean over fewer days is a different input than the one it was fitted on.
 */
export function trailing30DayMeanSpot(
  issueDate: string,
  dailyMeanSpots: ReadonlyMap<string, number>
): { available: true; meanSpot: number } | { available: false; missingDates: string[] } {
  const windowDates = trailingWindowDates(issueDate);
  const missingDates = windowDates.filter(date => !Number.isFinite(dailyMeanSpots.get(date)));
  if (missingDates.length) return { available: false, missingDates };
  const meanSpot = windowDates.reduce((sum, date) => sum + (dailyMeanSpots.get(date) ?? 0), 0) / windowDates.length;
  return { available: true, meanSpot };
}

/**
 * Each Europe/Stockholm day's mean spot over the given slots, the study's daily mean (every slot of the
 * day, so 92 or 100 of them on the DST days). Pass whole days: a partial day's mean isn't the day's.
 */
export function dailyMeanSpotsOfSlots(slots: PriceSlot15[]): Map<string, number> {
  const sums = new Map<string, { spotSum: number; slotCount: number }>();
  for (const slot of slots) {
    const date = stockholmDateOf(slot.startMs);
    const bucket = sums.get(date) ?? { spotSum: 0, slotCount: 0 };
    bucket.spotSum += slot.spot;
    bucket.slotCount += 1;
    sums.set(date, bucket);
  }
  const means = new Map<string, number>();
  for (const [date, bucket] of sums) means.set(date, bucket.spotSum / bucket.slotCount);
  return means;
}
