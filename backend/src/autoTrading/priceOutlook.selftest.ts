/**
 * Self-test of the SE3 daily-mean spot outlook (priceOutlook.ts): parity with the winter study's
 * out-of-sample predictions on its own cached forecasts, the 2026-10 cheap-to-expensive switch, the
 * study's live run for 2026-11-02, missing inputs, the power curve and the open-meteo reply mapping
 * (the calendar and DST day bucketing: priceOutlookCalendar.selftest.ts). Run from backend/ with:
 *   yarn node src/autoTrading/priceOutlook.selftest.ts
 *
 * Fixture (fixtures/priceOutlookWeather.json): 144 hourly values (D+1…D+6) per site and issue day.
 * The study fed each target day D+k the forecast issued k+1 days before it (previous-runs API column
 * *_previous_day{k+1}; D+1 from *_previous_day2), whereas the live call returns one latest run. The
 * fixture stitches those per-day columns into the live shape, one hourly series per site, so
 * predictDailyMeanSpots sees exactly the study's inputs. 2026-11-02 is the study's live latest-run
 * response, unstitched. The study's hours carry CET labels; all its days here are CET days.
 */
import { readFileSync } from "fs";
import process from "process";
import { predictDailyMeanSpots, turbineCapacityFactor } from "./priceOutlook.ts";
import { addDays, stockholmDateOf } from "./priceOutlookCalendar.ts";
import {
  isOutlookAvailableForArea,
  OUTLOOK_TEMPERATURE_POINTS,
  OUTLOOK_WIND_POINTS,
} from "./priceOutlookCoefficients.ts";
import { parseOutlookWeather } from "./priceOutlookWeather.ts";
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
    note: "D+1 is the DST switch day",
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

// ---------- power curve and area gate ----------
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
}

// ---------- open-meteo reply mapping ----------
{
  const firstSeconds = Date.parse("2026-11-01T23:00:00Z") / 1000;
  const requestOrder = [...WIND_POINT_NAMES, ...TEMPERATURE_POINT_NAMES];
  const reply = requestOrder.map((_pointName, index) => ({
    location_id: index,
    utc_offset_seconds: 3600,
    hourly: {
      time: [firstSeconds, firstSeconds + 3600],
      wind_speed_100m: [index, null],
      temperature_2m: [index + 0.5, index + 1.5],
    },
  }));
  const parsed = parseOutlookWeather(reply, 42);
  check(
    "reply: sites map by request order, unix seconds become instants, null hours drop",
    parsed.windSpeedByPoint.DK1_west.length === 1 &&
      parsed.windSpeedByPoint.DK1_west[0].atMs === firstSeconds * 1000 &&
      parsed.windSpeedByPoint.SE1_markbygden[0].value === requestOrder.indexOf("SE1_markbygden") &&
      parsed.temperatureByPoint.Orebro.map(sample => sample.value).join() ===
        `${requestOrder.indexOf("Orebro") + 0.5},${requestOrder.indexOf("Orebro") + 1.5}` &&
      parsed.fetchedAtMs === 42
  );
  const swapped = structuredClone(reply);
  swapped[0].location_id = 1;
  swapped[1].location_id = 0;
  check(
    "reply: a reordered reply is refused rather than swapping sites",
    throws(() => parseOutlookWeather(swapped, 0))
  );
  check(
    "reply: a missing point is refused",
    throws(() => parseOutlookWeather(reply.slice(1), 0))
  );
  const labelled = structuredClone(reply).map(entry => ({
    ...entry,
    hourly: { ...entry.hourly, time: ["2026-11-02T00:00", "2026-11-02T01:00"] },
  }));
  check(
    "reply: local-time labels (no timeformat=unixtime) are refused",
    throws(() => parseOutlookWeather(labelled, 0))
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

function fixtureSamples(firstHourMs: number, values: (number | null)[]): HourlyWeatherSample[] {
  const samples: HourlyWeatherSample[] = [];
  values.forEach((value, hourIndex) => {
    if (value !== null) samples.push({ atMs: firstHourMs + hourIndex * HOUR_MS, value });
  });
  return samples;
}

function throws(action: () => unknown): boolean {
  try {
    action();
    return false;
  } catch {
    return true;
  }
}
