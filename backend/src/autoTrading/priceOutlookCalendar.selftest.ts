/**
 * Self-test of the price outlook's calendar (priceOutlookCalendar.ts): the study's weekends and
 * holidays, date arithmetic, Europe/Stockholm day bucketing across the DST switches, where a day
 * has 23 or 25 forecast hours, and the fitted-season flag on a summer outlook. Run from backend/ with:
 *   yarn node src/autoTrading/priceOutlookCalendar.selftest.ts
 */
import process from "process";
import { dailyMeansByStockholmDate, dailyOutlookWeather, predictDailyMeanSpots } from "./priceOutlook.ts";
import { addDays, easterSunday, isNonWorkingDay, stockholmDateOf } from "./priceOutlookCalendar.ts";
import { OUTLOOK_TEMPERATURE_POINTS, OUTLOOK_WIND_POINTS } from "./priceOutlookCoefficients.ts";
import type {
  HourlyWeatherSample,
  OutlookTemperaturePointName,
  OutlookWeather,
  OutlookWindPointName,
} from "./priceOutlook.types.ts";

const failedChecks: string[] = [];
function check(name: string, passed: boolean, detail = "") {
  console.log(`${passed ? "PASS" : "FAIL"}: ${name} ${detail}`);
  if (!passed) failedChecks.push(name);
}

const HOUR_MS = 3600_000;
const WIND_POINT_NAMES = Object.keys(OUTLOOK_WIND_POINTS) as OutlookWindPointName[];
const TEMPERATURE_POINT_NAMES = Object.keys(OUTLOOK_TEMPERATURE_POINTS) as OutlookTemperaturePointName[];

// ---------- holiday calendar (the study's) ----------
{
  const knownEasters: Record<number, string> = {
    2008: "2008-03-23",
    2011: "2011-04-24",
    2019: "2019-04-21",
    2024: "2024-03-31",
    2025: "2025-04-20",
    2026: "2026-04-05",
    2027: "2027-03-28",
    2038: "2038-04-25",
    2285: "2285-03-22",
  };
  const wrongEasters = Object.entries(knownEasters).filter(([year, date]) => easterSunday(Number(year)) !== date);
  check(
    "calendar: Easter Sunday, including the earliest and latest possible dates",
    !wrongEasters.length,
    wrongEasters.map(([year]) => `${year}: ${easterSunday(Number(year))}`).join(", ")
  );
  const nonWorking = [
    "2026-04-03", // Good Friday
    "2026-04-06", // Easter Monday
    "2026-05-14", // Ascension Day
    "2026-01-01",
    "2026-01-06",
    "2026-05-01",
    "2025-06-06", // National Day on a Friday
    "2025-12-24",
    "2025-12-25",
    "2025-12-26",
    "2025-12-31",
    "2026-11-07", // Saturday
    "2026-11-08", // Sunday
  ];
  const working = [
    "2026-04-02", // Maundy Thursday
    "2026-04-07",
    "2026-05-13",
    "2026-06-19", // Midsummer Eve: not in the study's calendar, so not in the model's
    "2026-11-02",
    "2026-12-23",
  ];
  const wrong = [
    ...nonWorking.filter(date => !isNonWorkingDay(date)),
    ...working.filter(date => isNonWorkingDay(date)),
  ];
  check("calendar: the study's weekends and holidays, and nothing more", !wrong.length, wrong.join(", "));
  check(
    "calendar: date arithmetic across month, year and leap day",
    addDays("2028-02-28", 1) === "2028-02-29" &&
      addDays("2026-12-31", 1) === "2027-01-01" &&
      addDays("2026-03-01", -1) === "2026-02-28" &&
      addDays("2026-10-24", 2) === "2026-10-26"
  );
}

// ---------- Europe/Stockholm days across the DST switches ----------
{
  check(
    "dst: autumn day boundaries (00:00 CEST = 22:00Z, 00:00 CET = 23:00Z)",
    stockholmDateOf(Date.parse("2026-10-24T21:59:59Z")) === "2026-10-24" &&
      stockholmDateOf(Date.parse("2026-10-24T22:00:00Z")) === "2026-10-25" &&
      stockholmDateOf(Date.parse("2026-10-25T22:59:59Z")) === "2026-10-25" &&
      stockholmDateOf(Date.parse("2026-10-25T23:00:00Z")) === "2026-10-26"
  );
  const autumn = hourlySamples("2026-10-23T22:00:00Z", 24 + 25 + 24, hourIndex => hourIndex);
  const autumnMeans = dailyMeansByStockholmDate(autumn);
  const switchDay = autumnMeans.get("2026-10-25");
  check(
    "dst: the autumn switch day buckets 25 hours, its neighbours 24",
    autumnMeans.get("2026-10-24")?.sampleCount === 24 &&
      switchDay?.sampleCount === 25 &&
      autumnMeans.get("2026-10-26")?.sampleCount === 24 &&
      switchDay.mean === (24 + 48) / 2,
    `(${[...autumnMeans].map(([date, bucket]) => `${date}: ${bucket.sampleCount} h`).join(", ")})`
  );
  const spring = hourlySamples("2026-03-27T23:00:00Z", 24 + 23 + 24, () => 1);
  const springMeans = dailyMeansByStockholmDate(spring);
  check(
    "dst: the spring switch day buckets 23 hours, its neighbours 24",
    springMeans.get("2026-03-28")?.sampleCount === 24 &&
      springMeans.get("2026-03-29")?.sampleCount === 23 &&
      springMeans.get("2026-03-30")?.sampleCount === 24,
    `(${[...springMeans].map(([date, bucket]) => `${date}: ${bucket.sampleCount} h`).join(", ")})`
  );
  const switchWeather = uniformWeather(hourlySamples("2026-10-23T22:00:00Z", 24 + 25 + 24, () => 7.5));
  const switchDays = dailyOutlookWeather(switchWeather);
  check(
    "dst: 23 h and 25 h days count as complete model days",
    switchDays.has("2026-10-25") &&
      dailyOutlookWeather(uniformWeather(hourlySamples("2026-03-27T23:00:00Z", 71, () => 7.5))).has("2026-03-29")
  );
}

// ---------- outside the fitted months ----------
{
  // June 1 00:00 CEST onwards, 8 days: covers D+1…D+6 of a June 1 issue
  const summerWeather = uniformWeather(hourlySamples("2026-05-31T22:00:00Z", 8 * 24, () => 7.5));
  const summer = predictDailyMeanSpots({
    weather: summerWeather,
    issueDate: "2026-06-01",
    dayAheadMeanSpot: 0.5,
    trailing30DayMeanSpot: 0.5,
  });
  check(
    "season: a June issue date still predicts, flagged as outside the fitted months",
    summer.available && !summer.outlook.withinFittedSeason,
    `(${summer.available ? `withinFittedSeason ${summer.outlook.withinFittedSeason}` : summer.reason})`
  );
}

console.log(
  failedChecks.length ? `\n${failedChecks.length} FAILURES: ${failedChecks.join(", ")}` : "\nAll scenarios passed"
);
process.exit(failedChecks.length ? 1 : 0);

function hourlySamples(firstHourIso: string, hours: number, valueAt: (hourIndex: number) => number) {
  const firstHourMs = Date.parse(firstHourIso);
  return Array.from({ length: hours }, (_unused, hourIndex) => ({
    atMs: firstHourMs + hourIndex * HOUR_MS,
    value: valueAt(hourIndex),
  }));
}

/** Every site and city reads the same samples */
function uniformWeather(samples: HourlyWeatherSample[]): OutlookWeather {
  const windSpeedByPoint = {} as Record<OutlookWindPointName, HourlyWeatherSample[]>;
  const temperatureByPoint = {} as Record<OutlookTemperaturePointName, HourlyWeatherSample[]>;
  for (const pointName of WIND_POINT_NAMES) windSpeedByPoint[pointName] = samples;
  for (const pointName of TEMPERATURE_POINT_NAMES) temperatureByPoint[pointName] = samples;
  return { fetchedAtMs: 0, windSpeedByPoint, temperatureByPoint };
}
