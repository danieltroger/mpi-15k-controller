/**
 * Self-test of the shared Stockholm date helper (stockholmDate.ts), which replaced three copies:
 * tradingPerformance's localDateStr and priceService's dateInStockholm (both toLocaleDateString("sv-SE",
 * { timeZone: "Europe/Stockholm" })) and the price outlook's stockholmDateOf. The consolidation is a pure
 * refactor, so the old formulation is the reference: the instants either side of every local midnight across
 * 2022–2030 (both DST switches of every year). Run from backend/ with:
 *   yarn node src/utilities/stockholmDate.selftest.ts
 */
import process from "process";
import { addDays, calendarDateParts, stockholmDateOf } from "./stockholmDate.ts";

const failedChecks: string[] = [];
function check(name: string, passed: boolean, detail = "") {
  console.log(`${passed ? "PASS" : "FAIL"}: ${name} ${detail}`);
  if (!passed) failedChecks.push(name);
}

const HOUR_MS = 3600_000;

/** What localDateStr and dateInStockholm computed before the consolidation */
function legacyStockholmDate(ms: number): string {
  return new Date(ms).toLocaleDateString("sv-SE", { timeZone: "Europe/Stockholm" });
}

// ---------- identical to the legacy formulation ----------
{
  const mismatches: string[] = [];
  let compared = 0;
  for (let dayStartMs = Date.UTC(2022, 0, 1); dayStartMs < Date.UTC(2031, 0, 1); dayStartMs += 24 * HOUR_MS) {
    // Local midnight is 22:00Z (CEST) or 23:00Z (CET): a millisecond either side of both, and midday
    const instants = [12, 22, 23].flatMap(hour => [dayStartMs + hour * HOUR_MS - 1, dayStartMs + hour * HOUR_MS]);
    for (const instant of instants) {
      compared++;
      if (stockholmDateOf(instant) !== legacyStockholmDate(instant) && mismatches.length < 5) {
        mismatches.push(
          `${new Date(instant).toISOString()}: ${stockholmDateOf(instant)} vs ${legacyStockholmDate(instant)}`
        );
      }
    }
  }
  check(
    "legacy parity: either side of every local midnight 2022–2030 matches toLocaleDateString",
    !mismatches.length,
    `(${compared} instants${mismatches.length ? `; ${mismatches.join("; ")}` : ""})`
  );
  // Fractional instants: tradingPerformance buckets a window by its midpoint, (start + end) / 2
  const midpoint = (Date.parse("2026-10-24T21:45:00Z") + Date.parse("2026-10-24T22:15:00Z") + 1) / 2;
  check(
    "legacy parity: a fractional millisecond instant",
    stockholmDateOf(midpoint) === legacyStockholmDate(midpoint) && stockholmDateOf(midpoint) === "2026-10-25"
  );
}

// ---------- day boundaries across the DST switches ----------
{
  check(
    "dst: autumn day boundaries (00:00 CEST = 22:00Z, 00:00 CET = 23:00Z)",
    stockholmDateOf(Date.parse("2026-10-24T21:59:59Z")) === "2026-10-24" &&
      stockholmDateOf(Date.parse("2026-10-24T22:00:00Z")) === "2026-10-25" &&
      stockholmDateOf(Date.parse("2026-10-25T22:59:59Z")) === "2026-10-25" &&
      stockholmDateOf(Date.parse("2026-10-25T23:00:00Z")) === "2026-10-26"
  );
  check(
    "dst: spring day boundaries (00:00 CET = 23:00Z, 00:00 CEST = 22:00Z)",
    stockholmDateOf(Date.parse("2026-03-28T22:59:59Z")) === "2026-03-28" &&
      stockholmDateOf(Date.parse("2026-03-28T23:00:00Z")) === "2026-03-29" &&
      stockholmDateOf(Date.parse("2026-03-29T21:59:59Z")) === "2026-03-29" &&
      stockholmDateOf(Date.parse("2026-03-29T22:00:00Z")) === "2026-03-30"
  );
  // priceService asks for "tomorrow" as now + 24 h, kept as it was: on the 25-hour day's first hour that
  // lands on the same date (the refactor changes no behaviour, this pins what the behaviour is)
  const firstHourOfLongDay = Date.parse("2026-10-24T22:30:00Z");
  check(
    "dst: now + 24 h is still the same date in the 25-hour day's first hour (unchanged behaviour)",
    stockholmDateOf(firstHourOfLongDay + 24 * HOUR_MS) === "2026-10-25" &&
      legacyStockholmDate(firstHourOfLongDay + 24 * HOUR_MS) === "2026-10-25"
  );
}

// ---------- calendar arithmetic ----------
{
  check(
    "addDays: across month, year and leap day, both directions",
    addDays("2028-02-28", 1) === "2028-02-29" &&
      addDays("2028-02-29", 1) === "2028-03-01" &&
      addDays("2027-02-28", 1) === "2027-03-01" &&
      addDays("2026-12-31", 1) === "2027-01-01" &&
      addDays("2026-03-01", -1) === "2026-02-28" &&
      addDays("2026-10-24", 2) === "2026-10-26" &&
      addDays("2026-11-03", -30) === "2026-10-04" &&
      addDays("2026-11-03", 0) === "2026-11-03"
  );
  // expectedSpot's completeDaysBefore used Date.UTC arithmetic on the parts; addDays must agree with it
  const mismatches: string[] = [];
  for (let dayIndex = 0; dayIndex < 3 * 366; dayIndex++) {
    const date = new Date(Date.UTC(2025, 0, 1 + dayIndex)).toISOString().slice(0, 10);
    const [year, month, day] = date.split("-").map(Number);
    for (const daysBack of [1, 7, 30, 60]) {
      const legacy = new Date(Date.UTC(year, month - 1, day - daysBack)).toISOString().slice(0, 10);
      if (addDays(date, -daysBack) !== legacy && mismatches.length < 5) mismatches.push(`${date} − ${daysBack}`);
    }
  }
  check(
    "addDays: agrees with the Date.UTC arithmetic it replaced (2025–2027)",
    !mismatches.length,
    mismatches.join(", ")
  );
  let threw = false;
  try {
    calendarDateParts("2026-11-3");
  } catch {
    threw = true;
  }
  check(
    "calendarDateParts: parses YYYY-MM-DD and refuses anything else",
    JSON.stringify(calendarDateParts("2026-11-03")) === JSON.stringify([2026, 11, 3]) && threw
  );
}

console.log(
  failedChecks.length ? `\n${failedChecks.length} FAILURES: ${failedChecks.join(", ")}` : "\nAll scenarios passed"
);
process.exit(failedChecks.length ? 1 : 0);
