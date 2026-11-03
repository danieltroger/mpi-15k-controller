/**
 * Self-test of the SE3 daily-mean spot outlook (priceOutlook.ts): parity with the winter study's
 * out-of-sample predictions on its own cached forecasts, the 2026-10 cheap-to-expensive switch, the
 * study's live run for 2026-11-02, the live 25-hour DST day, missing inputs, the power curve and the
 * area and season gates (calendar and DST bucketing: priceOutlookCalendar.selftest.ts; the open-meteo
 * reply mapping: priceOutlookWeather.selftest.ts). Run from backend/ with:
 *   yarn node src/autoTrading/priceOutlook.selftest.ts
 *
 * Fixture (fixtures/priceOutlookWeather.json): 144 hourly values (D+1…D+6) per site and issue day.
 * The study fed each target day D+k the forecast issued k+1 days before it (previous-runs API column
 * *_previous_day{k+1}; D+1 from *_previous_day2), whereas the live call returns one latest run. The
 * fixture stitches those per-day columns into the live shape, one hourly series per site, so
 * predictDailyMeanSpots sees exactly the study's inputs. 2026-11-02 is the study's live latest-run
 * response, unstitched. The study's hours carry CET labels; all its days here are CET days, so the
 * CSV cases see 24 h on the 2026-10-25 DST switch day, as the study did. 2026-10-24 also carries the
 * hour before its first one (00:00 CEST on 10-25), so a separate case runs that day with the 25
 * Stockholm hours the live call buckets, against the study's formulas on Stockholm days.
 */
import { readFileSync } from "fs";
import process from "process";
import { dailyMeansByStockholmDate, predictDailyMeanSpots, turbineCapacityFactor } from "./priceOutlook.ts";
import { addDays, stockholmDateOf } from "../utilities/stockholmDate.ts";
import {
  isOutlookAvailableForArea,
  isOutlookFittedForIssueDate,
  OUTLOOK_TEMPERATURE_POINTS,
  OUTLOOK_WIND_POINTS,
} from "./priceOutlookCoefficients.ts";
import type {
  HourlyWeatherSample,
  OutlookTemperaturePointName,
  OutlookWeather,
  OutlookWindPointName,
  PriceOutlook,
} from "./priceOutlook.types.ts";

const failedChecks: string[] = [];
function check(name: string, passed: boolean, detail = "") {
  console.log(`${passed ? "PASS" : "FAIL"}: ${name} ${detail}`);
  if (!passed) failedChecks.push(name);
}

const HOUR_MS = 3600_000;
const WIND_POINT_NAMES = Object.keys(OUTLOOK_WIND_POINTS) as OutlookWindPointName[];
const TEMPERATURE_POINT_NAMES = Object.keys(OUTLOOK_TEMPERATURE_POINTS) as OutlookTemperaturePointName[];

type FixtureIssueDay = {
  first_hour_ms: number;
  wind_speed_100m: Record<OutlookWindPointName, (number | null)[]>;
  temperature_2m: Record<OutlookTemperaturePointName, (number | null)[]>;
  /** The hour at first_hour_ms − 1 h, same run as D+1 (2026-10-24 only) */
  hour_before_first?: {
    wind_speed_100m: Record<OutlookWindPointName, number>;
    temperature_2m: Record<OutlookTemperaturePointName, number>;
  };
};
const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/priceOutlookWeather.json", import.meta.url), { encoding: "utf-8" })
) as { source: string; issue_days: Record<string, FixtureIssueDay> };

/**
 * The study's prices (elprisetjustnu SE3 daily means; trailing = mean of D−28…D+1) and outputs. The
 * CSV rows are predictions_oos_2025-10_2026-11.csv, rounded to 4 decimals there; 2026-11-02 is
 * live_now.py's arithmetic at full precision (the script prints 2 decimals: 1.48 1.55 1.90 1.11 1.69).
 */
const STUDY_CASES: {
  issueDate: string;
  dayAheadMeanSpot: number;
  trailing30DayMeanSpot: number;
  /** D+2…D+6 */
  expectedDays: number[];
  expectedMeanD2toD4: number;
  expectedMaxD2toD5: number;
  reference: "csv" | "live_now";
  note: string;
}[] = [
  {
    issueDate: "2025-12-22",
    dayAheadMeanSpot: 0.5760671875,
    trailing30DayMeanSpot: 0.6386060277777776,
    expectedDays: [0.3655, 0.1785, 0.312, 0.1334, 0.0053],
    expectedMeanD2toD4: 0.2853,
    expectedMaxD2toD5: 0.3655,
    reference: "csv",
    note: "D+2…D+4 are Christmas Eve, Christmas Day and Boxing Day",
  },
  {
    issueDate: "2025-12-30",
    dayAheadMeanSpot: 0.84907375,
    trailing30DayMeanSpot: 0.5135995590277777,
    expectedDays: [0.3483, 0.7961, 0.9387, 1.2093, 2.306],
    expectedMeanD2toD4: 0.6944,
    expectedMaxD2toD5: 1.2093,
    reference: "csv",
    note: "D+1 is New Year's Eve, D+2 New Year's Day",
  },
  {
    issueDate: "2026-10-24",
    dayAheadMeanSpot: 0.0191626,
    trailing30DayMeanSpot: 0.803341933888889,
    expectedDays: [0.3015, 0.3208, 0.331, 0.4058, 0.8569],
    expectedMeanD2toD4: 0.3178,
    expectedMaxD2toD5: 0.4058,
    reference: "csv",
    note: "D+1 is the DST switch day, bucketed as the study saw it: 24 CET hours",
  },
  {
    issueDate: "2026-10-25",
    dayAheadMeanSpot: 0.11541739583333331,
    trailing30DayMeanSpot: 0.7852923818055555,
    expectedDays: [0.1361, 0.1576, 0.3817, 0.6417, 0.4698],
    expectedMeanD2toD4: 0.2251,
    expectedMaxD2toD5: 0.6417,
    reference: "csv",
    note: "",
  },
  {
    issueDate: "2026-10-26",
    dayAheadMeanSpot: 0.13371270833333335,
    trailing30DayMeanSpot: 0.7645658019444446,
    expectedDays: [0.289, 0.4991, 0.759, 0.7139, 0.6469],
    expectedMeanD2toD4: 0.5157,
    expectedMaxD2toD5: 0.759,
    reference: "csv",
    note: "",
  },
  {
    issueDate: "2026-10-27",
    dayAheadMeanSpot: 0.9873439583333332,
    trailing30DayMeanSpot: 0.7756356943055557,
    expectedDays: [1.1803, 1.3186, 1.1255, 0.8864, 1.2422],
    expectedMeanD2toD4: 1.2081,
    expectedMaxD2toD5: 1.3186,
    reference: "csv",
    note: "",
  },
  {
    issueDate: "2026-11-02",
    dayAheadMeanSpot: 1.84566,
    trailing30DayMeanSpot: 0.9261221352777778,
    expectedDays: [1.4838142263826133, 1.54908422105029, 1.9026604512025413, 1.1053055300881334, 1.6861551566305621],
    expectedMeanD2toD4: 1.6451862995451483,
    expectedMaxD2toD5: 1.9026604512025413,
    reference: "live_now",
    note: "latest-run forecast, not stitched",
  },
];

/** Half a unit in the CSV's 4th decimal, plus float noise; live_now.py's arithmetic is matched to float noise */
const TOLERANCE = { csv: 0.5e-4 + 1e-9, live_now: 1e-9 };

// ---------- parity with the study ----------
const outlooks = new Map<string, PriceOutlook>();
{
  let maxCsvDifference = 0;
  for (const studyCase of STUDY_CASES) {
    const fixtureDay = fixture.issue_days[studyCase.issueDate];
    const result = predictDailyMeanSpots({
      weather: fixtureWeather(fixtureDay),
      issueDate: studyCase.issueDate,
      dayAheadMeanSpot: studyCase.dayAheadMeanSpot,
      trailing30DayMeanSpot: studyCase.trailing30DayMeanSpot,
    });
    if (!result.available) {
      check(`study ${studyCase.issueDate}: outlook available`, false, `(${result.reason})`);
      continue;
    }
    outlooks.set(studyCase.issueDate, result.outlook);
    const predicted = [
      ...result.outlook.days.map(day => day.predictedMeanSpot),
      result.outlook.meanD2toD4,
      result.outlook.maxD2toD5,
    ];
    const expected = [...studyCase.expectedDays, studyCase.expectedMeanD2toD4, studyCase.expectedMaxD2toD5];
    const differences = predicted.map((value, index) => Math.abs(value - expected[index]));
    const maxDifference = Math.max(...differences);
    if (studyCase.reference === "csv") maxCsvDifference = Math.max(maxCsvDifference, maxDifference);
    check(
      `study ${studyCase.issueDate}: D+2…D+6, mean D+2…4 and max D+2…5 match ${studyCase.reference}${studyCase.note ? ` (${studyCase.note})` : ""}`,
      predicted.length === 7 && maxDifference <= TOLERANCE[studyCase.reference],
      `(max |Δ| ${maxDifference.toExponential(2)}; ${predicted.map(value => value.toFixed(4)).join(" ")})`
    );
    check(
      `study ${studyCase.issueDate}: days are D+2…D+6 in order`,
      result.outlook.days.map(day => day.date).join() ===
        [2, 3, 4, 5, 6].map(leadDays => addDays(studyCase.issueDate, leadDays)).join()
    );
  }
  console.log(`  max |Δ| against the study's CSV over all its cases: ${maxCsvDifference.toExponential(2)} SEK/kWh`);
}

// ---------- the 2026-10 switch from ~0 to ~1.5 SEK, seen 2–4 days ahead ----------
{
  const maxima = ["2026-10-24", "2026-10-25", "2026-10-26", "2026-10-27"].map(issueDate =>
    outlooks.get(issueDate)?.maxD2toD5.toFixed(2)
  );
  check(
    "switch: predicted max D+2…5 rises 0.41 → 0.64 → 0.76 → 1.32 while D+1 sits at 0.02–0.13",
    maxima.join(" → ") === "0.41 → 0.64 → 0.76 → 1.32",
    `(${maxima.join(" → ")})`
  );
  const christmas = outlooks.get("2025-12-22");
  check(
    "holidays: Christmas Eve…Boxing Day predicted below the working D+1",
    !!christmas &&
      christmas.days.slice(0, 3).every(day => day.nonWorkingDay && day.predictedMeanSpot < christmas.dayAheadMeanSpot),
    `(${christmas?.days.map(day => `${day.date}${day.nonWorkingDay ? "*" : ""} ${day.predictedMeanSpot.toFixed(2)}`).join(", ")})`
  );
}

// ---------- the live path on the 25-hour DST day ----------
// Issue 2026-10-24 with D+1 = 2026-10-25 bucketed into its 25 Stockholm hours, as the live call does.
// Reference: the study's formulas (live_now.py) on the same hourly values, bucketed into Stockholm
// days by Python's zoneinfo instead of by CET label.
{
  const issueDate = "2026-10-24";
  const weather = withHourBeforeFirst(fixtureWeather(fixture.issue_days[issueDate]), fixture.issue_days[issueDate]);
  const switchDayHours = [
    dailyMeansByStockholmDate(weather.windSpeedByPoint.SE2_central).get("2026-10-25")?.sampleCount,
    dailyMeansByStockholmDate(weather.temperatureByPoint.Stockholm).get("2026-10-25")?.sampleCount,
  ];
  check(
    "dst parity: D+1 = 2026-10-25 holds 25 hours at the sites and cities",
    switchDayHours.every(hours => hours === 25),
    `(${switchDayHours.join(", ")})`
  );
  const result = predictDailyMeanSpots({
    weather,
    issueDate,
    dayAheadMeanSpot: 0.0191626,
    trailing30DayMeanSpot: 0.803341933888889,
  });
  const expected = [
    0.2978076239659641, 0.3169228791338287, 0.32704846420197925, 0.40114577060201645, 0.8491584859157746,
    0.313926322433924, 0.40114577060201645,
  ];
  const predicted = result.available
    ? [...result.outlook.days.map(day => day.predictedMeanSpot), result.outlook.meanD2toD4, result.outlook.maxD2toD5]
    : [];
  const maxDifference = Math.max(...predicted.map((value, index) => Math.abs(value - expected[index])));
  check(
    "dst parity: the 25-hour D+1 matches the study's formulas on Stockholm days",
    predicted.length === 7 && maxDifference <= TOLERANCE.live_now,
    `(max |Δ| ${maxDifference.toExponential(2)}; ${predicted.map(value => value.toFixed(4)).join(" ")})`
  );
  const studyDay = outlooks.get(issueDate);
  check(
    "dst parity: the 25th hour moves the prediction off the study's 24-hour day",
    !!studyDay && result.available && Math.abs(result.outlook.meanD2toD4 - studyDay.meanD2toD4) > 1e-3,
    `(mean D+2…4 ${result.available ? result.outlook.meanD2toD4.toFixed(4) : "–"} vs ${studyDay?.meanD2toD4.toFixed(4)})`
  );
}

// ---------- missing inputs: unavailable, never a guess ----------
{
  const issueDate = "2026-10-27";
  const weather = fixtureWeather(fixture.issue_days[issueDate]);
  const dateD4 = addDays(issueDate, 4);
  weather.windSpeedByPoint.SE2_central = weather.windSpeedByPoint.SE2_central.filter(
    // A gappy D+4: 19 of 24 hours left at one site
    sample => stockholmDateOf(sample.atMs) !== dateD4 || new Date(sample.atMs).getUTCHours() < 19
  );
  const gappy = predictDailyMeanSpots({ weather, issueDate, dayAheadMeanSpot: 1, trailing30DayMeanSpot: 1 });
  check(
    "missing: a day with under 20 hours at one site makes the outlook unavailable",
    !gappy.available && gappy.reason.includes(`D+4 (${dateD4})`),
    `(${gappy.available ? "available" : gappy.reason})`
  );
  const unpriced = predictDailyMeanSpots({
    weather: fixtureWeather(fixture.issue_days[issueDate]),
    issueDate,
    dayAheadMeanSpot: Number.NaN,
    trailing30DayMeanSpot: 1,
  });
  check("missing: no D+1 mean makes the outlook unavailable", !unpriced.available);
  const tooEarly = predictDailyMeanSpots({
    weather: fixtureWeather(fixture.issue_days[issueDate]),
    issueDate: addDays(issueDate, 1),
    dayAheadMeanSpot: 1,
    trailing30DayMeanSpot: 1,
  });
  check(
    "missing: weather ending before D+6 makes the outlook unavailable",
    !tooEarly.available && tooEarly.reason.includes("D+6")
  );
}

// ---------- power curve, area and season gates ----------
{
  check(
    "power curve: zero below cut-in and from cut-out, cubic in between, flat at rated",
    turbineCapacityFactor(2.99) === 0 &&
      turbineCapacityFactor(3) === 0 &&
      Math.abs(turbineCapacityFactor(7.5) - (7.5 ** 3 - 27) / (1728 - 27)) < 1e-12 &&
      turbineCapacityFactor(12) === 1 &&
      turbineCapacityFactor(24.99) === 1 &&
      turbineCapacityFactor(25) === 0
  );
  check(
    "area: the SE3-fitted model is offered for SE3 only",
    isOutlookAvailableForArea("SE3") && !isOutlookAvailableForArea("SE4") && !isOutlookAvailableForArea("SE2")
  );
  check(
    "season: issue dates from October 1 through March 31 are in the fitted months, April–September not",
    isOutlookFittedForIssueDate("2026-10-01") &&
      isOutlookFittedForIssueDate("2026-12-31") &&
      isOutlookFittedForIssueDate("2027-01-01") &&
      isOutlookFittedForIssueDate("2026-03-31") &&
      !isOutlookFittedForIssueDate("2026-04-01") &&
      !isOutlookFittedForIssueDate("2026-07-15") &&
      !isOutlookFittedForIssueDate("2026-09-30")
  );
  check(
    "season: every study outlook carries withinFittedSeason",
    outlooks.size === STUDY_CASES.length && [...outlooks.values()].every(outlook => outlook.withinFittedSeason)
  );
}

console.log(
  failedChecks.length ? `\n${failedChecks.length} FAILURES: ${failedChecks.join(", ")}` : "\nAll scenarios passed"
);
process.exit(failedChecks.length ? 1 : 0);

function fixtureWeather(fixtureDay: FixtureIssueDay): OutlookWeather {
  const windSpeedByPoint = {} as Record<OutlookWindPointName, HourlyWeatherSample[]>;
  const temperatureByPoint = {} as Record<OutlookTemperaturePointName, HourlyWeatherSample[]>;
  for (const pointName of WIND_POINT_NAMES) {
    windSpeedByPoint[pointName] = fixtureSamples(fixtureDay.first_hour_ms, fixtureDay.wind_speed_100m[pointName]);
  }
  for (const pointName of TEMPERATURE_POINT_NAMES) {
    temperatureByPoint[pointName] = fixtureSamples(fixtureDay.first_hour_ms, fixtureDay.temperature_2m[pointName]);
  }
  return { fetchedAtMs: fixtureDay.first_hour_ms, windSpeedByPoint, temperatureByPoint };
}

/** The fixture day's hour before its first, prepended to every series (00:00 CEST of the 25-hour 2026-10-25) */
function withHourBeforeFirst(weather: OutlookWeather, fixtureDay: FixtureIssueDay): OutlookWeather {
  const hourBefore = fixtureDay.hour_before_first;
  if (!hourBefore) throw new Error("fixture day has no hour_before_first");
  const atMs = fixtureDay.first_hour_ms - HOUR_MS;
  for (const pointName of WIND_POINT_NAMES) {
    weather.windSpeedByPoint[pointName].unshift({ atMs, value: hourBefore.wind_speed_100m[pointName] });
  }
  for (const pointName of TEMPERATURE_POINT_NAMES) {
    weather.temperatureByPoint[pointName].unshift({ atMs, value: hourBefore.temperature_2m[pointName] });
  }
  return weather;
}

function fixtureSamples(firstHourMs: number, values: (number | null)[]): HourlyWeatherSample[] {
  const samples: HourlyWeatherSample[] = [];
  values.forEach((value, hourIndex) => {
    if (value !== null) samples.push({ atMs: firstHourMs + hourIndex * HOUR_MS, value });
  });
  return samples;
}
