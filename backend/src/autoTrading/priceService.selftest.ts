/**
 * Self-test of which days priceService fetches and how it merges them (priceService.ts). "Tomorrow" is the
 * next calendar day, also in the two hours a year where now + 24 h isn't: the 25-hour autumn day's first
 * hour (now + 24 h is still today, so today was fetched twice and every slot doubled) and the spring-forward
 * eve's last hour (now + 24 h is Monday, so Sunday was never fetched). A slot start can't appear twice in the
 * merged prices, and a duplicate is warned about. fetchPrices also runs end to end against a stubbed price
 * API and clock. Run from backend/ with:
 *   yarn node src/autoTrading/priceService.selftest.ts
 */
import process from "process";
import { addDays, stockholmDateOf } from "../utilities/stockholmDate.ts";
import { type ApiEntry, entriesToSlots, fetchPrices, priceDatesToFetch } from "./priceService.ts";
import type { FetchedPrices } from "./priceService.types.ts";
import type { PriceSlot15 } from "./planner.types.ts";
import { SLOT_MS } from "./slotDuration.ts";

const failedChecks: string[] = [];
function check(name: string, passed: boolean, detail = "") {
  console.log(`${passed ? "PASS" : "FAIL"}: ${name} ${detail}`);
  if (!passed) failedChecks.push(name);
}

const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;

/** 2026-10-25 00:30 CEST: the first hour of the 25-hour day (clocks go back at 03:00) */
const AUTUMN_FIRST_HOUR_MS = Date.parse("2026-10-24T22:30:00Z");
/** 2026-03-28 23:30 CET: the last hour before the 23-hour day (clocks go forward at 02:00) */
const SPRING_EVE_LAST_HOUR_MS = Date.parse("2026-03-28T22:30:00Z");

/** What fetchDay asked for before the fix: the Stockholm dates of now and now + 24 h */
function legacyDatesToFetch(nowMs: number): { todayDate: string; tomorrowDate: string } {
  return { todayDate: stockholmDateOf(nowMs), tomorrowDate: stockholmDateOf(nowMs + DAY_MS) };
}

const capturedWarnings: string[] = [];
const realConsoleWarn = console.warn;
console.warn = (...args: unknown[]) => {
  capturedWarnings.push(args.map(String).join(" "));
  realConsoleWarn(...args);
};

// ---------- the two DST hours ----------
{
  const autumn = priceDatesToFetch(AUTUMN_FIRST_HOUR_MS);
  check(
    "dst: autumn 00:30 fetches today and the next calendar day (now + 24 h fetched today twice)",
    autumn.todayDate === "2026-10-25" &&
      autumn.tomorrowDate === "2026-10-26" &&
      legacyDatesToFetch(AUTUMN_FIRST_HOUR_MS).tomorrowDate === "2026-10-25",
    JSON.stringify(autumn)
  );
  const spring = priceDatesToFetch(SPRING_EVE_LAST_HOUR_MS);
  check(
    "dst: spring-forward eve 23:30 fetches Saturday and Sunday (now + 24 h skipped to Monday)",
    spring.todayDate === "2026-03-28" &&
      spring.tomorrowDate === "2026-03-29" &&
      legacyDatesToFetch(SPRING_EVE_LAST_HOUR_MS).tomorrowDate === "2026-03-30",
    JSON.stringify(spring)
  );
}

// ---------- unchanged outside those hours ----------
// Every 15 min for three weeks either side of each switch: today never changes, and tomorrow differs from
// before only in that switch's buggy hour, 22:00–23:00Z on the eve of the switch date (00:00–01:00 CEST on
// the autumn day, 23:00–24:00 CET on the spring eve), always the next calendar day.
{
  const SWEEP_DAYS = 21;
  const dstSwitches = [
    {
      name: "spring 2026",
      atMs: Date.parse("2026-03-29T01:00:00Z"),
      buggyHourStartMs: Date.parse("2026-03-28T22:00:00Z"),
    },
    {
      name: "autumn 2026",
      atMs: Date.parse("2026-10-25T01:00:00Z"),
      buggyHourStartMs: Date.parse("2026-10-24T22:00:00Z"),
    },
    {
      name: "spring 2027",
      atMs: Date.parse("2027-03-28T01:00:00Z"),
      buggyHourStartMs: Date.parse("2027-03-27T22:00:00Z"),
    },
    {
      name: "autumn 2027",
      atMs: Date.parse("2027-10-31T01:00:00Z"),
      buggyHourStartMs: Date.parse("2027-10-30T22:00:00Z"),
    },
  ];
  for (const dstSwitch of dstSwitches) {
    const unexpected: string[] = [];
    let compared = 0;
    let changedInBuggyHour = 0;
    const sweepEndMs = dstSwitch.atMs + SWEEP_DAYS * DAY_MS;
    for (let nowMs = dstSwitch.atMs - SWEEP_DAYS * DAY_MS; nowMs < sweepEndMs; nowMs += SLOT_MS) {
      compared++;
      const fixed = priceDatesToFetch(nowMs);
      const legacy = legacyDatesToFetch(nowMs);
      const inBuggyHour = nowMs >= dstSwitch.buggyHourStartMs && nowMs < dstSwitch.buggyHourStartMs + HOUR_MS;
      const nextCalendarDay =
        fixed.todayDate === legacy.todayDate && fixed.tomorrowDate === addDays(fixed.todayDate, 1);
      const changed = fixed.tomorrowDate !== legacy.tomorrowDate;
      if (!nextCalendarDay || changed !== inBuggyHour) {
        unexpected.push(`${new Date(nowMs).toISOString()} (${fixed.tomorrowDate} vs ${legacy.tomorrowDate})`);
      }
      if (inBuggyHour && changed) changedInBuggyHour++;
    }
    check(
      `sweep: ${dstSwitch.name}, same dates as before except the buggy hour, where tomorrow is the next day`,
      !unexpected.length && changedInBuggyHour === HOUR_MS / SLOT_MS,
      `(${compared} instants, ${changedInBuggyHour} changed${unexpected.length ? `; unexpected at ${unexpected.slice(0, 5).join(", ")}` : ""})`
    );
  }
}

// ---------- merged slots: one per start ----------
{
  const longDay = apiEntriesForDate("2026-10-25", 1);
  const nextDay = apiEntriesForDate("2026-10-26", 2);
  capturedWarnings.length = 0;
  const merged = entriesToSlots([...longDay, ...nextDay]);
  check(
    "merge: the 25-hour day and the next, 100 + 96 contiguous slots, no warning",
    longDay.length === 100 &&
      nextDay.length === 96 &&
      merged.length === 196 &&
      isContiguous(merged) &&
      !capturedWarnings.length,
    `(${longDay.length} + ${nextDay.length} → ${merged.length}, ${capturedWarnings.length} warnings)`
  );

  capturedWarnings.length = 0;
  const doubled = entriesToSlots([...longDay, ...longDay]);
  check(
    "merge: the same day twice (the old autumn 00:xx fetch) keeps each slot once, and warns",
    doubled.length === 100 &&
      isContiguous(doubled) &&
      capturedWarnings.length === 1 &&
      capturedWarnings[0].includes("100 duplicate"),
    `(${doubled.length} slots, ${capturedWarnings.length} warning)`
  );

  capturedWarnings.length = 0;
  const overlapping = entriesToSlots([
    { SEK_per_kWh: 1, time_start: "2026-11-03T09:00:00Z", time_end: "2026-11-03T10:00:00Z" },
    { SEK_per_kWh: 5, time_start: "2026-11-03T09:30:00Z", time_end: "2026-11-03T09:45:00Z" },
  ]);
  check(
    "merge: an hourly entry overlapping a 15-min one keeps the first price for the shared slot, and warns",
    overlapping.length === 4 &&
      overlapping.every(slot => slot.spot === 1) &&
      capturedWarnings.length === 1 &&
      capturedWarnings[0].includes("1 duplicate") &&
      capturedWarnings[0].includes("2026-11-03T09:30:00.000Z"),
    `(${overlapping.length} slots, ${capturedWarnings.length} warning)`
  );
}

// ---------- fetchPrices end to end ----------
{
  capturedWarnings.length = 0;
  // At 00:30 the next day's auction hasn't published yet
  const autumn = await fetchPricesAt(AUTUMN_FIRST_HOUR_MS, ["2026-10-25"]);
  check(
    "fetch: autumn 00:30 asks for the 25th and the 26th, 100 slots once each, tomorrow not included",
    autumn.requestedDates.join() === "2026-10-25,2026-10-26" &&
      autumn.prices.slots.length === 100 &&
      isContiguous(autumn.prices.slots) &&
      !autumn.prices.coversTomorrow &&
      autumn.prices.horizonEndMs === Date.parse("2026-10-25T23:00:00Z"),
    `(asked ${autumn.requestedDates.join(", ")}; ${autumn.prices.slots.length} slots, coversTomorrow ${autumn.prices.coversTomorrow}, horizon end ${new Date(autumn.prices.horizonEndMs).toISOString()})`
  );
  const spring = await fetchPricesAt(SPRING_EVE_LAST_HOUR_MS, ["2026-03-28", "2026-03-29"]);
  check(
    "fetch: spring-forward eve 23:30 asks for Saturday and Sunday, 96 + 92 slots, horizon to Sunday's end",
    spring.requestedDates.join() === "2026-03-28,2026-03-29" &&
      spring.prices.slots.length === 188 &&
      isContiguous(spring.prices.slots) &&
      spring.prices.coversTomorrow &&
      spring.prices.horizonEndMs === Date.parse("2026-03-29T22:00:00Z"),
    `(asked ${spring.requestedDates.join(", ")}; ${spring.prices.slots.length} slots, coversTomorrow ${spring.prices.coversTomorrow}, horizon end ${new Date(spring.prices.horizonEndMs).toISOString()})`
  );
  check("fetch: no duplicate-slot warning on either", !capturedWarnings.length, capturedWarnings.join(" | "));
}

console.warn = realConsoleWarn;
console.log(
  failedChecks.length ? `\n${failedChecks.length} FAILURES: ${failedChecks.join(", ")}` : "\nAll scenarios passed"
);
process.exit(failedChecks.length ? 1 : 0);

/** fetchPrices at a frozen clock against a stubbed price API that has only `publishedDates` (404 otherwise) */
async function fetchPricesAt(
  nowMs: number,
  publishedDates: string[]
): Promise<{ prices: FetchedPrices; requestedDates: string[] }> {
  const realFetch = globalThis.fetch;
  const realDateNow = Date.now;
  const requestedDates: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const match = /\/(\d{4})\/(\d{2})-(\d{2})_SE3\.json$/.exec(url);
    if (!match) throw new Error(`Unexpected price URL ${url}`);
    const date = `${match[1]}-${match[2]}-${match[3]}`;
    requestedDates.push(date);
    if (!publishedDates.includes(date)) return new Response("not published", { status: 404 });
    return new Response(JSON.stringify(apiEntriesForDate(date, 1)), { status: 200 });
  }) as typeof fetch;
  Date.now = () => nowMs;
  try {
    const prices = await fetchPrices("SE3", true);
    return { prices, requestedDates: requestedDates.sort() };
  } finally {
    globalThis.fetch = realFetch;
    Date.now = realDateNow;
  }
}

/** One Stockholm day's API entries in 15-min steps (92, 96 or 100 of them) */
function apiEntriesForDate(date: string, spotBase: number): ApiEntry[] {
  const entries: ApiEntry[] = [];
  // Local midnight is 22:00Z or 23:00Z the UTC day before: start before both and step up to it
  let slotStartMs = Date.parse(`${date}T00:00:00Z`) - 3 * HOUR_MS;
  while (stockholmDateOf(slotStartMs) !== date) slotStartMs += SLOT_MS;
  for (; stockholmDateOf(slotStartMs) === date; slotStartMs += SLOT_MS) {
    entries.push({
      SEK_per_kWh: spotBase + entries.length / 1000,
      time_start: new Date(slotStartMs).toISOString(),
      time_end: new Date(slotStartMs + SLOT_MS).toISOString(),
    });
  }
  return entries;
}

/** Sorted, one slot every 15 min, no start twice */
function isContiguous(slots: PriceSlot15[]): boolean {
  return slots.every((slot, index) => index === 0 || slot.startMs - slots[index - 1].startMs === SLOT_MS);
}
