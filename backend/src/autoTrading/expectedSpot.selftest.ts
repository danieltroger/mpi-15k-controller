/**
 * Self-test of the trailing expected spot's plumbing: which days count as the last complete ones and the
 * mean over a partial window (expectedSpot.ts), and the price history cache (priceHistory.ts) — a day
 * fetched once, a failure reported without throwing, warned about once and retried only after the backoff,
 * at most 4 fetches at once, old days dropped. No network: the day fetch is faked. Run from backend/ with:
 *   yarn node src/autoTrading/expectedSpot.selftest.ts
 */
import { completeDaysBefore, trailingEstimateFromDays } from "./expectedSpot.ts";
import { dailyMeanSpots, type DailyMeanSpotsRequest } from "./priceHistory.ts";
import { check, finishSelftest } from "./plannerSelftestFixtures.ts";
import type { PriceSlot15 } from "./planner.types.ts";

const MINUTE_MS = 60_000;

// ---------- The last complete days are Swedish calendar days before today ----------
{
  // 2026-11-02 00:30 in Sweden (CET) is still 2026-11-01 in UTC
  const justAfterMidnight = completeDaysBefore(Date.UTC(2026, 10, 1, 23, 30), 3);
  check(
    "complete days: counted from the Swedish date",
    JSON.stringify(justAfterMidnight) === JSON.stringify(["2026-11-01", "2026-10-31", "2026-10-30"]),
    `(${justAfterMidnight.join(", ")})`
  );
  // Across the 25-hour 2026-10-25 and a month boundary
  const acrossDst = completeDaysBefore(Date.UTC(2026, 9, 27, 12), 4);
  check(
    "complete days: a DST change and a month boundary skip nothing",
    JSON.stringify(acrossDst) === JSON.stringify(["2026-10-26", "2026-10-25", "2026-10-24", "2026-10-23"]),
    `(${acrossDst.join(", ")})`
  );
  check(
    "complete days: across the new year",
    JSON.stringify(completeDaysBefore(Date.UTC(2027, 0, 1, 12), 2)) === JSON.stringify(["2026-12-31", "2026-12-30"])
  );
}

// ---------- The history cache: fetched once, failures reported and backed off ----------
{
  const fetchedDates: string[] = [];
  let failingDate: string | undefined;
  const fakeFetch = async (area: string, date: string): Promise<PriceSlot15[]> => {
    fetchedDates.push(date);
    if (date === failingDate) throw new Error("connect timeout");
    if (date === "2026-10-20") return [];
    // A day priced at its day-of-month / 10, one hour at twice that
    const dayPrice = Number(date.slice(8)) / 10;
    return Array.from({ length: 96 }, (_, quarter) => ({
      startMs: quarter,
      spot: quarter < 4 ? dayPrice * 2 : dayPrice,
    }));
  };
  const request = (dates: string[], nowMs: number, area = "SE3"): DailyMeanSpotsRequest => ({
    area,
    dates,
    nowMs,
    retryAfterFailureMs: 15 * MINUTE_MS,
    fetchDaySlots: fakeFetch,
  });

  const first = await dailyMeanSpots(request(["2026-10-30", "2026-10-29"], 0));
  check(
    "history: each day's mean over its quarters",
    !first.failure &&
      first.means.length === 2 &&
      Math.abs(first.means[0].meanSpot - 3.0 * (100 / 96)) < 1e-9 &&
      first.means[0].date === "2026-10-30",
    `(${JSON.stringify(first)})`
  );
  fetchedDates.length = 0;
  const again = await dailyMeanSpots(request(["2026-10-31", "2026-10-30", "2026-10-29"], MINUTE_MS));
  check(
    "history: a cached day isn't fetched again",
    JSON.stringify(fetchedDates) === JSON.stringify(["2026-10-31"]) && again.means.length === 3 && !again.failure,
    `(fetched ${fetchedDates.join(", ")})`
  );

  failingDate = "2026-10-28";
  fetchedDates.length = 0;
  const failed = await dailyMeanSpots(request(["2026-10-30", "2026-10-28", "2026-10-20"], 2 * MINUTE_MS));
  check(
    "history: a failed or unpublished day is reported, not thrown, and the rest still comes back",
    failed.means.length === 1 &&
      !!failed.failure?.includes("2026-10-28: Error: connect timeout") &&
      !!failed.failure?.includes("2026-10-20: not published"),
    `(${failed.failure})`
  );
  fetchedDates.length = 0;
  failingDate = undefined;
  const backedOff = await dailyMeanSpots(request(["2026-10-30", "2026-10-28"], 10 * MINUTE_MS));
  check(
    "history: within the backoff the missing days aren't fetched again",
    fetchedDates.length === 0 && !!backedOff.failure?.includes("retrying after"),
    `(${backedOff.failure})`
  );
  const otherArea = await dailyMeanSpots(request(["2026-10-28"], 10 * MINUTE_MS, "SE4"));
  check("history: the backoff is per price area", fetchedDates.length === 1 && !otherArea.failure);
  fetchedDates.length = 0;
  const retried = await dailyMeanSpots(request(["2026-10-30", "2026-10-28"], 18 * MINUTE_MS));
  check(
    "history: after the backoff only the missing day is fetched, and it recovers",
    JSON.stringify(fetchedDates) === JSON.stringify(["2026-10-28"]) && !retried.failure && retried.means.length === 2,
    `(fetched ${fetchedDates.join(", ")}, ${retried.failure})`
  );
}

// ---------- Backoff groups: the outlook's failing days don't hold back the trailing estimate's new day ----------
{
  const fetchedDates: string[] = [];
  const fetchFailingOn28th = async (area: string, date: string): Promise<PriceSlot15[]> => {
    fetchedDates.push(date);
    if (date === "2026-10-28") throw new Error("connect timeout");
    return [{ startMs: 0, spot: 1 }];
  };
  const request = (dates: string[], nowMs: number, backoffGroup?: string): DailyMeanSpotsRequest => ({
    area: "NO1",
    dates,
    nowMs,
    retryAfterFailureMs: 15 * MINUTE_MS,
    fetchDaySlots: fetchFailingOn28th,
    backoffGroup,
  });
  await dailyMeanSpots(request(["2026-10-28"], 0, "price outlook"));
  fetchedDates.length = 0;
  const trailingDay = await dailyMeanSpots(request(["2026-10-27"], MINUTE_MS));
  const trailingFetched = [...fetchedDates];
  fetchedDates.length = 0;
  const outlookAgain = await dailyMeanSpots(request(["2026-10-26", "2026-10-28"], 2 * MINUTE_MS, "price outlook"));
  check(
    "history: a group's failure backs off only that group (the cached days stay shared)",
    JSON.stringify(trailingFetched) === JSON.stringify(["2026-10-27"]) &&
      !trailingDay.failure &&
      fetchedDates.length === 0 &&
      !!outlookAgain.failure?.includes("retrying after"),
    `(the default group fetched ${trailingFetched.join(", ")}; the outlook group ${fetchedDates.length ? `fetched ${fetchedDates.join(", ")}` : "backed off"})`
  );
}

// ---------- A failing day is warned about once, not on every retry ----------
{
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
  let failing = true;
  const flakyFetch = async (): Promise<PriceSlot15[]> => {
    if (failing) throw new Error("connect timeout");
    return [{ startMs: 0, spot: 1 }];
  };
  const request = (nowMs: number): DailyMeanSpotsRequest => ({
    area: "SE2",
    dates: ["2026-10-28"],
    nowMs,
    retryAfterFailureMs: 15 * MINUTE_MS,
    fetchDaySlots: flakyFetch,
  });
  await dailyMeanSpots(request(0));
  await dailyMeanSpots(request(5 * MINUTE_MS)); // backing off
  await dailyMeanSpots(request(20 * MINUTE_MS)); // retried, still failing
  const warningsWhileFailing = warnings.length;
  failing = false;
  const recovered = await dailyMeanSpots(request(40 * MINUTE_MS));
  console.warn = originalWarn;
  check(
    "history warnings: one per failing day, none on the retries, none on recovery",
    warningsWhileFailing === 1 && warnings.length === 1 && !recovered.failure,
    `(${warnings.length} warnings)`
  );
}

// ---------- Fetches are capped at 4 at once, and days no window can use are dropped ----------
{
  let inFlight = 0;
  let mostInFlight = 0;
  const fetchedDates: string[] = [];
  const slowFetch = async (area: string, date: string): Promise<PriceSlot15[]> => {
    fetchedDates.push(date);
    inFlight++;
    mostInFlight = Math.max(mostInFlight, inFlight);
    await new Promise(resolve => setTimeout(resolve, 5));
    inFlight--;
    return [{ startMs: 0, spot: 1 }];
  };
  const tenDays = Array.from({ length: 10 }, (_, dayIndex) => `2026-10-${String(dayIndex + 1).padStart(2, "0")}`);
  const request = (dates: string[], nowMs: number): DailyMeanSpotsRequest => ({
    area: "SE1",
    dates,
    nowMs,
    retryAfterFailureMs: 15 * MINUTE_MS,
    fetchDaySlots: slowFetch,
  });
  const cold = await dailyMeanSpots(request(tenDays, Date.UTC(2026, 9, 11)));
  check(
    "history: at most 4 day fetches at once",
    mostInFlight === 4 && cold.means.length === 10 && fetchedDates.length === 10,
    `(${mostInFlight} at once, ${fetchedDates.length} fetched)`
  );
  // Three months on, October is outside even a 60-day window: it is dropped, so asking again fetches it
  await dailyMeanSpots(request(["2027-01-14"], Date.UTC(2027, 0, 15)));
  fetchedDates.length = 0;
  await dailyMeanSpots(request(["2026-10-01"], Date.UTC(2027, 0, 15)));
  check("history: days older than the longest window are dropped", fetchedDates.includes("2026-10-01"));
}

// ---------- The trailing mean makes do with the days at hand while at least half are there ----------
{
  const dailyMean = (meanSpot: number, dayIndex: number) => ({ date: `2026-10-2${dayIndex}`, meanSpot });
  const sixOfSeven = trailingEstimateFromDays(
    [1, 1.2, 0.8, 1, 1.1, 0.9].map(dailyMean),
    7,
    "no SE3 prices for 2026-10-26: not published"
  );
  check(
    "partial mean: 6 of 7 days → their mean, and the detail says so",
    Math.abs((sixOfSeven.expectedSpot ?? NaN) - 1) < 1e-9 && sixOfSeven.detail === "7-day mean spot (6 of 7 days)",
    `(${JSON.stringify(sixOfSeven)})`
  );
  const fourOfSeven = trailingEstimateFromDays([1, 1.2, 0.8, 1].map(dailyMean), 7, "no SE3 prices for …");
  check("partial mean: 4 of 7 (at least half) still counts", fourOfSeven.expectedSpot !== undefined);
  const threeOfSeven = trailingEstimateFromDays([1, 1.2, 0.8].map(dailyMean), 7, "no SE3 prices for …");
  check(
    "partial mean: 3 of 7 → no value, and why",
    threeOfSeven.expectedSpot === undefined && threeOfSeven.detail.includes("3 of 7 days at hand"),
    `(${threeOfSeven.detail})`
  );
  const complete = trailingEstimateFromDays([1, 2].map(dailyMean), 2, undefined);
  check(
    "partial mean: a complete window reads as before",
    complete.expectedSpot === 1.5 && complete.detail === "2-day mean spot"
  );
}

finishSelftest();
