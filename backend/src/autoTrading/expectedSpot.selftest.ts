/**
 * Self-test of the trailing expected spot's plumbing: which days count as the last complete ones
 * (expectedSpot.ts), and the price history cache (priceHistory.ts) — a day fetched once, a failure
 * reported without throwing and retried only after the backoff. No network: the day fetch is faked.
 * Run from backend/ with:
 *   yarn node src/autoTrading/expectedSpot.selftest.ts
 */
import { completeDaysBefore } from "./expectedSpot.ts";
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

finishSelftest();
