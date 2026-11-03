/**
 * Self-test of the utility meter export parser (utilityMeterCsv.ts): the BOM and the header block, decimal
 * commas, both autumn DST passes of the repeated hour (summer time first), the spring-forward quarter and
 * an hourly row that isn't a quarter. Run from backend/ with:
 *   yarn node src/grid/utilityMeterCsv.selftest.ts
 */
import process from "process";
import { parseUtilityMeterCsv, stockholmLocalTimeToUtcMs } from "./utilityMeterCsv.ts";

const failedChecks: string[] = [];
function check(name: string, passed: boolean, detail = "") {
  console.log(`${passed ? "PASS" : "FAIL"}: ${name} ${detail}`);
  if (!passed) failedChecks.push(name);
}

const utc = (isoText: string) => Date.parse(isoText);

// The export's layout, with a made-up facility id
const autumnExport = [
  "﻿Anläggnings-id;Tidpunkt för export;Energiprodukt;Starttidpunkt;Sluttidpunkt;Måttenhet",
  "000000000000000000;2026-11-03 12:36:40;Aktiv energi;2024-03-21 00:00:00;2026-11-03 06:00:00;kWh",
  "",
  "Starttidpunkt;Sluttidpunkt;Energiriktning;Kvalitet;Kvantitet",
  "2026-10-25 01:45:00;2026-10-25 02:00:00;Produktion;Uppmätt;0,013",
  "2026-10-25 02:00:00;2026-10-25 02:15:00;Produktion;Uppmätt;0,020",
  "2026-10-25 02:45:00;2026-10-25 02:00:00;Produktion;Uppmätt;0,011",
  "2026-10-25 02:00:00;2026-10-25 02:15:00;Produktion;Uppmätt;0,031",
  "2026-10-25 02:45:00;2026-10-25 03:00:00;Produktion;Uppmätt;0,017",
  "2026-10-25 03:00:00;2026-10-25 03:15:00;Produktion;Uppmätt;1,5",
  "",
].join("\r\n");
const autumn = parseUtilityMeterCsv(autumnExport);
check("parse: the direction comes from the rows", autumn.direction === "export");
check(
  "parse: every quarter row is read, the header block isn't",
  autumn.kwhByQuarterStartMs.size === 6 && autumn.skippedRows === 0
);
check(
  "parse: the first 02:00 is summer time (00:00 UTC)",
  autumn.kwhByQuarterStartMs.get(utc("2026-10-25T00:00:00Z")) === 0.02
);
check(
  "parse: the second 02:00 is winter time (01:00 UTC)",
  autumn.kwhByQuarterStartMs.get(utc("2026-10-25T01:00:00Z")) === 0.031
);
check(
  "parse: the summer-time 02:45 quarter, ending at the second 02:00, is a quarter",
  autumn.kwhByQuarterStartMs.get(utc("2026-10-25T00:45:00Z")) === 0.011
);
check(
  "parse: the winter-time 02:45 quarter ends at 03:00",
  autumn.kwhByQuarterStartMs.get(utc("2026-10-25T01:45:00Z")) === 0.017
);
check("parse: decimal commas", autumn.kwhByQuarterStartMs.get(utc("2026-10-25T02:00:00Z")) === 1.5);

const springAndHourly = [
  "Starttidpunkt;Sluttidpunkt;Energiriktning;Kvalitet;Kvantitet",
  "2026-03-29 01:45:00;2026-03-29 03:00:00;Förbrukning;Uppmätt;0,005",
  "2026-03-29 03:00:00;2026-03-29 03:15:00;Förbrukning;Uppmätt;0,009",
  "2023-01-10 05:00:00;2023-01-10 06:00:00;Förbrukning;Uppmätt;1,200",
].join("\n");
const spring = parseUtilityMeterCsv(springAndHourly);
check("parse: consumption rows are import", spring.direction === "import");
check(
  "parse: the spring-forward quarter 01:45 → 03:00 is one quarter (00:45 UTC)",
  spring.kwhByQuarterStartMs.get(utc("2026-03-29T00:45:00Z")) === 0.005 &&
    spring.kwhByQuarterStartMs.get(utc("2026-03-29T01:00:00Z")) === 0.009
);
check("parse: an hourly row is skipped and counted", spring.skippedRows === 1 && spring.kwhByQuarterStartMs.size === 2);

let gapRejected = false;
try {
  stockholmLocalTimeToUtcMs("2026-03-29 02:30:00", 0);
} catch {
  gapRejected = true;
}
check("time: a wall clock in the spring-forward gap is refused", gapRejected);
check(
  "time: an ordinary winter time is UTC+1",
  stockholmLocalTimeToUtcMs("2026-01-15 12:00:00", 0) === utc("2026-01-15T11:00:00Z")
);
check(
  "time: an ordinary summer time is UTC+2, whatever the occurrence",
  stockholmLocalTimeToUtcMs("2026-07-15 12:00:00", 1) === utc("2026-07-15T10:00:00Z")
);

let mixedRejected = false;
try {
  parseUtilityMeterCsv(`${springAndHourly}\n2026-03-29 03:15:00;2026-03-29 03:30:00;Produktion;Uppmätt;0,001`);
} catch {
  mixedRejected = true;
}
check("parse: a file mixing import and export rows is refused", mixedRejected);

console.log(
  failedChecks.length
    ? `\n${failedChecks.length} FAILURES: ${failedChecks.join(", ")}`
    : "\nAll meter export parser checks passed"
);
process.exit(failedChecks.length ? 1 : 0);
