/**
 * Self-test of the outlook's price inputs (priceOutlookInputs.ts): the issue-day rule, the D−28…D+1
 * trailing window and its all-30-days mean, and Stockholm daily means of 15-min slots across the DST
 * switch. Run from backend/ with:
 *   yarn node src/autoTrading/priceOutlookInputs.selftest.ts
 */
import process from "process";
import {
  dailyMeanSpotsOfSlots,
  outlookIssueDate,
  trailing30DayMeanSpot,
  trailingWindowDates,
} from "./priceOutlookInputs.ts";
import type { PriceSlot15 } from "./planner.types.ts";

const failedChecks: string[] = [];
function check(name: string, passed: boolean, detail = "") {
  console.log(`${passed ? "PASS" : "FAIL"}: ${name} ${detail}`);
  if (!passed) failedChecks.push(name);
}

const SLOT_MINUTES = 15;

// ---------- issue day ----------
{
  check(
    "issue day: today once tomorrow's prices are out, yesterday before (across a month end)",
    outlookIssueDate("2026-11-02", true) === "2026-11-02" &&
      outlookIssueDate("2026-11-02", false) === "2026-11-01" &&
      outlookIssueDate("2026-03-01", false) === "2026-02-28"
  );
}

// ---------- trailing window ----------
{
  const windowDates = trailingWindowDates("2026-11-02");
  check(
    "window: 30 days D−28…D+1, oldest first",
    windowDates.length === 30 && windowDates[0] === "2026-10-05" && windowDates[29] === "2026-11-03",
    `(${windowDates[0]} … ${windowDates[29]}, ${windowDates.length} days)`
  );
  const dailyMeans = new Map(windowDates.map((date, index) => [date, index + 1]));
  // Outside the window: must not count
  dailyMeans.set("2026-10-04", 1000);
  dailyMeans.set("2026-11-04", 1000);
  const complete = trailing30DayMeanSpot("2026-11-02", dailyMeans);
  check(
    "window: the mean of the 30 window days only",
    complete.available && complete.meanSpot === 15.5,
    `(${complete.available ? complete.meanSpot : complete.missingDates.join()})`
  );
  dailyMeans.delete("2026-10-20");
  dailyMeans.set("2026-10-21", Number.NaN);
  const gappy = trailing30DayMeanSpot("2026-11-02", dailyMeans);
  check(
    "window: a missing or non-finite day makes the mean unavailable, naming the days",
    !gappy.available && gappy.missingDates.join() === "2026-10-20,2026-10-21",
    `(${gappy.available ? gappy.meanSpot : gappy.missingDates.join()})`
  );
}

// ---------- daily means of slots ----------
{
  // 23:45 CEST on 10-24, then the 25-hour 2026-10-25 (100 slots) and 2026-10-26 (96 slots)
  const firstSlotMs = Date.parse("2026-10-24T21:45:00Z");
  const slots: PriceSlot15[] = Array.from({ length: 1 + 100 + 96 }, (_unused, index) => ({
    startMs: firstSlotMs + index * SLOT_MINUTES * 60_000,
    spot: index === 0 ? 1000 : index - 1,
  }));
  const means = dailyMeanSpotsOfSlots(slots);
  check(
    "daily means: Stockholm days, all 100 slots of the 25-hour day",
    means.size === 3 &&
      means.get("2026-10-24") === 1000 &&
      means.get("2026-10-25") === 49.5 &&
      means.get("2026-10-26") === 147.5,
    `(${[...means].map(([date, mean]) => `${date}: ${mean}`).join(", ")})`
  );
}

console.log(
  failedChecks.length ? `\n${failedChecks.length} FAILURES: ${failedChecks.join(", ")}` : "\nAll scenarios passed"
);
process.exit(failedChecks.length ? 1 : 0);
