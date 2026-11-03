/**
 * Self-test of terminal_value_mode "forecast" (expectedSpotForecast.ts, expectedSpotForecastEstimate.ts): the
 * outlook's mean of D+2…D+4 becomes p̂ (and reads right in the plan note), the issue day follows tomorrow's
 * prices, the value is held within the deviation limit of the trailing mean, and each way the outlook can be
 * missing falls back to the trailing estimate with the reason (warned about once per switch). No network: the
 * price history and the weather fetch are faked. Run from backend/ with:
 *   yarn node src/autoTrading/expectedSpotForecast.selftest.ts
 */
import { stockholmDateOf } from "../utilities/stockholmDate.ts";
import { type ForecastSources, forecastMeanSpot } from "./expectedSpotForecast.ts";
import { heldNear } from "./expectedSpotForecastEstimate.ts";
import { predictDailyMeanSpots } from "./priceOutlook.ts";
import { OUTLOOK_TEMPERATURE_POINTS, OUTLOOK_WIND_POINTS } from "./priceOutlookCoefficients.ts";
import { emptyOutlookWeatherCache } from "./priceOutlookWeatherCache.ts";
import { terminalValuationFor } from "./terminalValue.ts";
import { baseKnobs, check, EVERY_MONTH, finishSelftest } from "./plannerSelftestFixtures.ts";
import type { ExpectedSpotSettings } from "./expectedSpot.ts";
import type { ExpectedSpotEstimate, PriceSlot15 } from "./planner.types.ts";
import type {
  HourlyWeatherSample,
  OutlookTemperaturePointName,
  OutlookWeather,
  OutlookWindPointName,
} from "./priceOutlook.types.ts";

const HOUR_MS = 3600_000;
const MINUTE_MS = 60_000;
const SLOT_MS = 15 * MINUTE_MS;

const SETTINGS: ExpectedSpotSettings = {
  price_area: "SE3",
  replan_retry_minutes: 15,
  terminal_value_mode: "forecast",
  terminal_value_months: "10,11,12,1,2,3",
  terminal_value_trailing_days: 7,
  terminal_value_forecast_max_deviation_sek: 1,
  terminal_value_forecast_max_age_hours: 6,
  terminal_value_forecast_wait_seconds: 30,
};
const TRAILING: ExpectedSpotEstimate = { expectedSpot: 1, source: "trailing", detail: "7-day mean spot" };

/** Past days' fake prices: every day at 1.0 except the named ones; counts what was fetched */
const history = { fetchedDates: [] as string[], failingDates: new Set<string>() };
async function fakeDaySlots(area: string, date: string): Promise<PriceSlot15[]> {
  history.fetchedDates.push(date);
  if (history.failingDates.has(date)) throw new Error("connect timeout");
  return stockholmDaySlots(date, 1);
}

/** Fake open-meteo; windOn picks each Stockholm day's 100 m wind speed for every site */
function fakeWeatherSource(windOn: (date: string) => number) {
  const fake = {
    fetches: 0,
    failing: false,
    delayMs: 0,
    fetchWeather: async (nowMs: number): Promise<OutlookWeather> => {
      fake.fetches++;
      if (fake.delayMs) await new Promise(resolve => setTimeout(resolve, fake.delayMs));
      if (fake.failing) throw new Error("open-meteo weather fetch failed (connect timeout)");
      return uniformWeather(nowMs, "2026-11-01", 120, windOn);
    },
  };
  return fake;
}

function sourcesWith(fetchWeather: ForecastSources["fetchWeather"]): ForecastSources {
  return {
    fetchDaySlots: fakeDaySlots,
    fetchWeather,
    weatherCache: emptyOutlookWeatherCache(),
    transitions: { lastFallbackKind: undefined },
  };
}

// After tomorrow's prices: issued today, D+1 = tomorrow
const afternoonMs = Date.parse("2026-11-10T12:30:00Z"); // 13:30 CET
const todayAndTomorrow = [...stockholmDaySlots("2026-11-10", 1.2), ...stockholmDaySlots("2026-11-11", 0.8)];
const steadyWind = () => 8;

// ---------- The outlook's mean of D+2…D+4 is p̂ ----------
{
  const weatherSource = fakeWeatherSource(steadyWind);
  const sources = sourcesWith(weatherSource.fetchWeather);
  const estimate = await forecastMeanSpot(
    SETTINGS,
    { nowMs: afternoonMs, publishedSlots: todayAndTomorrow },
    TRAILING,
    sources
  );
  // The reference: the pure outlook on the same inputs (28 past days at 1.0, today 1.2, tomorrow 0.8)
  const reference = predictDailyMeanSpots({
    weather: uniformWeather(afternoonMs, "2026-11-01", 120, steadyWind),
    issueDate: "2026-11-10",
    dayAheadMeanSpot: 0.8,
    trailing30DayMeanSpot: (28 * 1 + 1.2 + 0.8) / 30,
  });
  const forecast = estimate.forecast;
  check(
    "forecast: p̂ is the outlook's mean of D+2..4, issued today once tomorrow is priced",
    reference.available &&
      estimate.source === "forecast" &&
      Math.abs((estimate.expectedSpot ?? NaN) - reference.outlook.meanD2toD4) < 1e-12 &&
      !!forecast?.used &&
      forecast.issueDate === "2026-11-10" &&
      forecast.days.map(day => day.date).join() === "2026-11-12,2026-11-13,2026-11-14" &&
      !forecast.limited &&
      forecast.trailingSpot === 1 &&
      forecast.weatherFetchedAt === new Date(afternoonMs).toISOString(),
    `(${estimate.expectedSpot} vs ${reference.available ? reference.outlook.meanD2toD4 : reference.reason})`
  );
  check(
    "forecast: the 30-day history comes from the price history (D−28…D−1), today and tomorrow from the plan's prices",
    history.fetchedDates.length === 28 &&
      history.fetchedDates.includes("2026-10-13") &&
      history.fetchedDates.includes("2026-11-09") &&
      !history.fetchedDates.includes("2026-11-10") &&
      !history.fetchedDates.includes("2026-11-11"),
    `(${history.fetchedDates.length} days fetched)`
  );
  const valuation = terminalValuationFor({
    nowMs: afternoonMs,
    expectedSpot: estimate,
    knobs: { ...baseKnobs, terminal_value_mode: "forecast", terminal_value_months: EVERY_MONTH },
  } as Parameters<typeof terminalValuationFor>[0]);
  check(
    "forecast: the plan note names the outlook, its three days and p̂",
    !!valuation.valuation?.basis.startsWith("price outlook mean spot D+2..4 (11-12 ") &&
      !!valuation.valuation?.basis.endsWith(`) ${estimate.expectedSpot?.toFixed(2)}, k 0.9`),
    `(${valuation.valuation?.basis})`
  );
  history.fetchedDates.length = 0;
  const again = await forecastMeanSpot(
    SETTINGS,
    { nowMs: afternoonMs + 10 * MINUTE_MS, publishedSlots: todayAndTomorrow },
    TRAILING,
    sources
  );
  check(
    "forecast: the next plan reuses the cached weather and history (no fetch at all)",
    weatherSource.fetches === 1 && history.fetchedDates.length === 0 && again.expectedSpot === estimate.expectedSpot
  );
}

// ---------- Before tomorrow's prices: issued yesterday, D+1 = today ----------
{
  const morningMs = Date.parse("2026-11-10T09:00:00Z"); // 10:00 CET
  const estimate = await forecastMeanSpot(
    SETTINGS,
    { nowMs: morningMs, publishedSlots: stockholmDaySlots("2026-11-10", 1.2) },
    TRAILING,
    sourcesWith(fakeWeatherSource(steadyWind).fetchWeather)
  );
  const forecast = estimate.forecast;
  check(
    "issue day: before tomorrow is priced the outlook is yesterday's, starting from today's prices",
    !!forecast?.used &&
      forecast.issueDate === "2026-11-09" &&
      forecast.days.map(day => day.date).join() === "2026-11-11,2026-11-12,2026-11-13",
    `(${estimate.detail})`
  );
  // A price cache fetched before midnight still "covers tomorrow"; the slots themselves say it is today now
  const stale = await forecastMeanSpot(
    SETTINGS,
    {
      nowMs: morningMs,
      publishedSlots: [...stockholmDaySlots("2026-11-09", 1), ...stockholmDaySlots("2026-11-10", 1.2)],
    },
    TRAILING,
    sourcesWith(fakeWeatherSource(steadyWind).fetchWeather)
  );
  check(
    "issue day: yesterday's and today's slots (an old price cache) still issue yesterday",
    !!stale.forecast?.used && stale.forecast.issueDate === "2026-11-09"
  );
}

// ---------- A wild prediction is held within the deviation limit of the trailing mean ----------
{
  // Windy D+1, calm from D+2: the outlook predicts a big price rise from tomorrow's 0.8
  const calmAfterTomorrow = (date: string) => (date <= "2026-11-11" ? 12 : 2);
  const estimate = await forecastMeanSpot(
    SETTINGS,
    { nowMs: afternoonMs, publishedSlots: todayAndTomorrow },
    TRAILING,
    sourcesWith(fakeWeatherSource(calmAfterTomorrow).fetchWeather)
  );
  const forecast = estimate.forecast;
  check(
    "limit: a prediction far above the trailing mean is held at trailing + the limit, and says so",
    estimate.expectedSpot === 2 &&
      !!forecast?.used &&
      forecast.limited &&
      forecast.predictedMeanSpot > 2.5 &&
      estimate.detail.includes("held within 1.00 of the 7-day mean spot 1.00 at"),
    `(${estimate.detail} ${estimate.expectedSpot})`
  );
  const unlimited = await forecastMeanSpot(
    { ...SETTINGS, terminal_value_forecast_max_deviation_sek: 3 },
    { nowMs: afternoonMs, publishedSlots: todayAndTomorrow },
    TRAILING,
    sourcesWith(fakeWeatherSource(calmAfterTomorrow).fetchWeather)
  );
  check(
    "limit: a wider limit lets the same prediction through",
    unlimited.forecast?.used === true &&
      !unlimited.forecast.limited &&
      !!forecast?.used &&
      unlimited.expectedSpot === forecast.predictedMeanSpot
  );
  check(
    "limit: symmetric, absolute SEK",
    heldNear(-1, 0.2, 0.5) === -0.3 && heldNear(0.4, 0.2, 0.5) === 0.4 && heldNear(3, 0.2, 0) === 0.2
  );
}

// ---------- Each unavailable input falls back to the trailing estimate, with the reason ----------
{
  const weatherSource = fakeWeatherSource(steadyWind);
  history.fetchedDates.length = 0;
  const area = await forecastMeanSpot(
    { ...SETTINGS, price_area: "SE4" },
    { nowMs: afternoonMs, publishedSlots: todayAndTomorrow },
    TRAILING,
    sourcesWith(weatherSource.fetchWeather)
  );
  check(
    "fallback: another price area → the trailing mean, the note says why, nothing is fetched",
    area.expectedSpot === 1 &&
      area.source === "trailing" &&
      area.detail ===
        "price outlook unavailable (its model is fitted to SE3 prices, not SE4), so the 7-day mean spot" &&
      area.forecast?.used === false &&
      weatherSource.fetches === 0 &&
      history.fetchedDates.length === 0,
    `(${area.detail})`
  );
  const april = await forecastMeanSpot(
    SETTINGS,
    {
      nowMs: Date.parse("2027-04-15T11:00:00Z"),
      publishedSlots: [...stockholmDaySlots("2027-04-15", 1), ...stockholmDaySlots("2027-04-16", 1)],
    },
    TRAILING,
    sourcesWith(weatherSource.fetchWeather)
  );
  const octoberFirstMorning = await forecastMeanSpot(
    SETTINGS,
    { nowMs: Date.parse("2026-10-01T06:00:00Z"), publishedSlots: stockholmDaySlots("2026-10-01", 1) },
    TRAILING,
    sourcesWith(weatherSource.fetchWeather)
  );
  check(
    "fallback: an issue day outside October–March (also Oct 1 before tomorrow's prices: issued Sep 30)",
    april.forecast?.used === false &&
      april.detail.includes("fitted to October–March issue days, not 2027-04-15") &&
      octoberFirstMorning.forecast?.used === false &&
      octoberFirstMorning.detail.includes("not 2026-09-30") &&
      weatherSource.fetches === 0,
    `(${octoberFirstMorning.detail})`
  );
  const noAnchor = await forecastMeanSpot(
    SETTINGS,
    { nowMs: afternoonMs, publishedSlots: todayAndTomorrow },
    {
      expectedSpot: undefined,
      source: "trailing",
      detail: "the 7-day mean spot is unavailable, 2 of 7 days at hand: …",
    },
    sourcesWith(weatherSource.fetchWeather)
  );
  check(
    "fallback: without a trailing mean to hold it near there is no value, and the note says both",
    noAnchor.expectedSpot === undefined &&
      noAnchor.detail.startsWith("the price outlook is unavailable (it is only used near the trailing mean") &&
      noAnchor.detail.includes("and the 7-day mean spot is unavailable, 2 of 7 days"),
    `(${noAnchor.detail})`
  );
  const noPrices = await forecastMeanSpot(
    SETTINGS,
    { nowMs: afternoonMs, publishedSlots: [] },
    TRAILING,
    sourcesWith(weatherSource.fetchWeather)
  );
  check(
    "fallback: no D+1 prices",
    noPrices.expectedSpot === 1 && noPrices.detail.includes("no SE3 prices for D+1 (2026-11-10)"),
    `(${noPrices.detail})`
  );
  weatherSource.failing = true;
  const noWeather = await forecastMeanSpot(
    SETTINGS,
    { nowMs: afternoonMs, publishedSlots: todayAndTomorrow },
    TRAILING,
    sourcesWith(weatherSource.fetchWeather)
  );
  check(
    "fallback: the weather fetch failing",
    noWeather.expectedSpot === 1 &&
      noWeather.detail.includes("no weather forecast: open-meteo weather fetch failed (connect timeout)"),
    `(${noWeather.detail})`
  );
}

// ---------- A slow weather fetch doesn't hold the plan up; the next plan gets it ----------
{
  const weatherSource = fakeWeatherSource(steadyWind);
  weatherSource.delayMs = 150;
  const sources = sourcesWith(weatherSource.fetchWeather);
  const quickSettings = { ...SETTINGS, terminal_value_forecast_wait_seconds: 0.03 };
  const startedMs = Date.now();
  const late = await forecastMeanSpot(
    quickSettings,
    { nowMs: afternoonMs, publishedSlots: todayAndTomorrow },
    TRAILING,
    sources
  );
  const waitedMs = Date.now() - startedMs;
  await new Promise(resolve => setTimeout(resolve, 200));
  const next = await forecastMeanSpot(
    quickSettings,
    { nowMs: afternoonMs + 15 * MINUTE_MS, publishedSlots: todayAndTomorrow },
    TRAILING,
    sources
  );
  check(
    "wait budget: the plan falls back after the budget, the fetch carries on, the next plan uses it",
    late.expectedSpot === 1 &&
      late.detail.includes("no weather forecast within 0.03 s, still fetching for the next plan") &&
      waitedMs < 120 &&
      next.forecast?.used === true &&
      weatherSource.fetches === 1,
    `(waited ${waitedMs} ms; ${late.detail})`
  );
}

// ---------- Warned once per switch, the way back logged ----------
{
  const warnings: string[] = [];
  const logs: string[] = [];
  const originalWarn = console.warn;
  const originalLog = console.log;
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
  console.log = (...args: unknown[]) => {
    if (String(args[0]).startsWith("[LOG]")) logs.push(args.map(String).join(" "));
    else originalLog(...args);
  };
  const weatherSource = fakeWeatherSource(steadyWind);
  const sources = sourcesWith(weatherSource.fetchWeather);
  const plan = (nowMs: number, area = "SE3") =>
    forecastMeanSpot({ ...SETTINGS, price_area: area }, { nowMs, publishedSlots: todayAndTomorrow }, TRAILING, sources);
  await plan(afternoonMs);
  const warningsWhileFine = warnings.length;
  await plan(afternoonMs + HOUR_MS, "SE4");
  await plan(afternoonMs + 2 * HOUR_MS, "SE4");
  const warningsAfterAreaSwitch = warnings.length;
  weatherSource.failing = true;
  await plan(afternoonMs + 8 * HOUR_MS);
  await plan(afternoonMs + 9 * HOUR_MS);
  const warningsAfterWeatherFailure = warnings.length;
  weatherSource.failing = false;
  const recovered = await plan(afternoonMs + 10 * HOUR_MS);
  console.warn = originalWarn;
  console.log = originalLog;
  const fallbackWarnings = warnings.filter(line => line.includes("Expected spot: the price outlook is unavailable"));
  check(
    "transitions: one warning into a fallback and one per change of reason, none while it lasts, the way back logged",
    warningsWhileFine === 0 &&
      warningsAfterAreaSwitch === 1 &&
      fallbackWarnings.length === 2 &&
      warningsAfterWeatherFailure === warningsAfterAreaSwitch + 2 &&
      recovered.forecast?.used === true &&
      logs.filter(line => line.includes("using the price outlook again")).length === 1,
    `(${warnings.length} warnings: ${warnings.join(" | ")}; ${logs.length} logs)`
  );
}

// ---------- A day missing from the 30-day history: fall back, retried after the interval ----------
// Last: the history's failure backoff is per area and would hold back later scenarios' first fetches
{
  const februaryMs = Date.parse("2027-02-10T12:30:00Z");
  const slots = [...stockholmDaySlots("2027-02-10", 1.5), ...stockholmDaySlots("2027-02-11", 1.5)];
  const sources = sourcesWith(fakeWeatherSource(steadyWind).fetchWeather);
  history.failingDates.add("2027-01-20");
  const missing = await forecastMeanSpot(SETTINGS, { nowMs: februaryMs, publishedSlots: slots }, TRAILING, sources);
  history.failingDates.clear();
  history.fetchedDates.length = 0;
  const backingOff = await forecastMeanSpot(
    SETTINGS,
    { nowMs: februaryMs + 5 * MINUTE_MS, publishedSlots: slots },
    TRAILING,
    sources
  );
  const retried = await forecastMeanSpot(
    SETTINGS,
    { nowMs: februaryMs + 20 * MINUTE_MS, publishedSlots: slots },
    TRAILING,
    sources
  );
  check(
    "history: a missing day → the trailing mean and which day; retried after the interval, then the outlook",
    missing.expectedSpot === 1 &&
      missing.detail.includes(
        "the 30-day price history lacks 1 day(s): no SE3 prices for 2027-01-20: Error: connect timeout"
      ) &&
      backingOff.forecast?.used === false &&
      retried.forecast?.used === true &&
      JSON.stringify(history.fetchedDates) === JSON.stringify(["2027-01-20"]),
    `(${missing.detail}; refetched ${history.fetchedDates.join(", ")})`
  );
}

finishSelftest();

/** A Europe/Stockholm day's 15-min slots (92 or 100 on the DST days) at one spot price */
function stockholmDaySlots(date: string, spot: number): PriceSlot15[] {
  let startMs = Date.parse(`${date}T00:00:00Z`) - 3 * HOUR_MS;
  while (stockholmDateOf(startMs) !== date) startMs += SLOT_MS;
  const slots: PriceSlot15[] = [];
  for (let slotMs = startMs; stockholmDateOf(slotMs) === date; slotMs += SLOT_MS) slots.push({ startMs: slotMs, spot });
  return slots;
}

/** Every site reads the same hourly wind (by Stockholm day) and every city 2 °C, from firstDate's midnight */
function uniformWeather(
  fetchedAtMs: number,
  firstDate: string,
  days: number,
  windOn: (date: string) => number
): OutlookWeather {
  const firstHourMs = stockholmDaySlots(firstDate, 0)[0].startMs;
  const hours = Array.from({ length: days * 24 }, (_unused, hourIndex) => firstHourMs + hourIndex * HOUR_MS);
  const wind: HourlyWeatherSample[] = hours.map(atMs => ({ atMs, value: windOn(stockholmDateOf(atMs)) }));
  const temperature: HourlyWeatherSample[] = hours.map(atMs => ({ atMs, value: 2 }));
  const windSpeedByPoint = {} as Record<OutlookWindPointName, HourlyWeatherSample[]>;
  const temperatureByPoint = {} as Record<OutlookTemperaturePointName, HourlyWeatherSample[]>;
  for (const pointName of Object.keys(OUTLOOK_WIND_POINTS) as OutlookWindPointName[]) {
    windSpeedByPoint[pointName] = wind;
  }
  for (const pointName of Object.keys(OUTLOOK_TEMPERATURE_POINTS) as OutlookTemperaturePointName[]) {
    temperatureByPoint[pointName] = temperature;
  }
  return { fetchedAtMs, windSpeedByPoint, temperatureByPoint };
}
