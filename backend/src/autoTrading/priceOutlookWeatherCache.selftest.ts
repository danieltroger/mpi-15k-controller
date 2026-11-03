/**
 * Self-test of the price outlook's weather cache (priceOutlookWeatherCache.ts): a fresh forecast is reused
 * and an old one refetched, plans arriving during a fetch share it, a failure backs off for the retry
 * interval and is warned about once per failing streak, and a forecast past its age is never handed out as
 * fresh. Also settleWithin (utilities/settleWithin.ts), which bounds how long a plan waits on it. No network:
 * the fetch is faked. Run from backend/ with:
 *   yarn node src/autoTrading/priceOutlookWeatherCache.selftest.ts
 */
import { settleWithin } from "../utilities/settleWithin.ts";
import {
  emptyOutlookWeatherCache,
  type OutlookWeatherRequest,
  outlookWeatherNoOlderThan,
} from "./priceOutlookWeatherCache.ts";
import { check, finishSelftest } from "./plannerSelftestFixtures.ts";
import type { OutlookWeather } from "./priceOutlook.types.ts";

const HOUR_MS = 3600_000;
const MINUTE_MS = 60_000;

function weatherFetchedAt(fetchedAtMs: number): OutlookWeather {
  return {
    fetchedAtMs,
    windSpeedByPoint: {} as OutlookWeather["windSpeedByPoint"],
    temperatureByPoint: {} as OutlookWeather["temperatureByPoint"],
  };
}

/** A fake open-meteo: counts fetches, fails while `failing`, takes `delayMs` */
function fakeFetcher() {
  const fake = {
    fetches: 0,
    failing: false,
    delayMs: 0,
    fetchWeather: async (nowMs: number): Promise<OutlookWeather> => {
      fake.fetches++;
      if (fake.delayMs) await new Promise(resolve => setTimeout(resolve, fake.delayMs));
      if (fake.failing) throw new Error("open-meteo weather fetch failed (connect timeout)");
      return weatherFetchedAt(nowMs);
    },
  };
  return fake;
}

function request(nowMs: number, fetchWeather: OutlookWeatherRequest["fetchWeather"]): OutlookWeatherRequest {
  return { nowMs, maxAgeMs: 6 * HOUR_MS, retryAfterFailureMs: 15 * MINUTE_MS, fetchWeather };
}

// ---------- reuse while fresh, refetch when old ----------
{
  const cache = emptyOutlookWeatherCache();
  const fake = fakeFetcher();
  const first = await outlookWeatherNoOlderThan(cache, request(0, fake.fetchWeather));
  const reused = await outlookWeatherNoOlderThan(cache, request(6 * HOUR_MS, fake.fetchWeather));
  check(
    "cache: the first plan fetches, a plan within the max age reuses it",
    first.weather?.fetchedAtMs === 0 && reused.weather?.fetchedAtMs === 0 && fake.fetches === 1,
    `(${fake.fetches} fetches)`
  );
  const refreshed = await outlookWeatherNoOlderThan(cache, request(6 * HOUR_MS + 1, fake.fetchWeather));
  check(
    "cache: past the max age a new forecast is fetched",
    refreshed.weather?.fetchedAtMs === 6 * HOUR_MS + 1 && fake.fetches === 2
  );
}

// ---------- plans arriving during a fetch share it ----------
{
  const cache = emptyOutlookWeatherCache();
  const fake = fakeFetcher();
  fake.delayMs = 30;
  const [first, second] = await Promise.all([
    outlookWeatherNoOlderThan(cache, request(0, fake.fetchWeather)),
    outlookWeatherNoOlderThan(cache, request(MINUTE_MS, fake.fetchWeather)),
  ]);
  check(
    "cache: two plans during one fetch share it (one request to open-meteo)",
    fake.fetches === 1 && first.weather === second.weather && !!first.weather
  );
}

// ---------- a failure: reported, backed off, warned about once per streak, never stale-as-fresh ----------
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
  const cache = emptyOutlookWeatherCache();
  const fake = fakeFetcher();
  await outlookWeatherNoOlderThan(cache, request(0, fake.fetchWeather));
  fake.failing = true;
  const stale = await outlookWeatherNoOlderThan(cache, request(7 * HOUR_MS, fake.fetchWeather));
  check(
    "failure: a forecast past its age isn't handed out when the refresh fails, and the reason says both",
    !stale.weather &&
      !!stale.problem?.includes("7.0 h old (max 6 h)") &&
      !!stale.problem?.includes("connect timeout") &&
      fake.fetches === 2,
    `(${stale.problem})`
  );
  const backingOff = await outlookWeatherNoOlderThan(cache, request(7 * HOUR_MS + 5 * MINUTE_MS, fake.fetchWeather));
  check(
    "failure: within the retry interval no new fetch, and the problem says when the next try is",
    fake.fetches === 2 && !!backingOff.problem?.includes("next try after"),
    `(${backingOff.problem})`
  );
  await outlookWeatherNoOlderThan(cache, request(7 * HOUR_MS + 20 * MINUTE_MS, fake.fetchWeather));
  const warningsWhileFailing = warnings.length;
  fake.failing = false;
  const recovered = await outlookWeatherNoOlderThan(cache, request(7 * HOUR_MS + 40 * MINUTE_MS, fake.fetchWeather));
  console.warn = originalWarn;
  console.log = originalLog;
  check(
    "failure: one warning for the failing streak (three fetches), its end logged, and the forecast is back",
    fake.fetches === 4 &&
      warningsWhileFailing === 1 &&
      warnings.length === 1 &&
      logs.some(line => line.includes("fetched again")) &&
      recovered.weather?.fetchedAtMs === 7 * HOUR_MS + 40 * MINUTE_MS,
    `(${fake.fetches} fetches, ${warnings.length} warnings, ${logs.length} logs)`
  );
  const neverFetched = await outlookWeatherNoOlderThan(emptyOutlookWeatherCache(), {
    ...request(0, async () => {
      throw new Error("unusable open-meteo weather response (expected one entry per point (11), got [])");
    }),
  });
  check(
    "failure: with nothing cached the problem names the fetch failure",
    !neverFetched.weather && !!neverFetched.problem?.startsWith("no weather forecast: unusable open-meteo"),
    `(${neverFetched.problem})`
  );
}

// ---------- settleWithin: bounds the wait, not the work ----------
{
  let finished = false;
  const slow = new Promise<string>(resolve =>
    setTimeout(() => {
      finished = true;
      resolve("late");
    }, 60)
  );
  const timedOut = await settleWithin(slow, 10);
  const meanwhile = finished;
  await slow;
  const quick = await settleWithin(Promise.resolve(42), 1000);
  check(
    "settleWithin: a slow promise times out without being cancelled; a quick one passes its value",
    !timedOut.settled && !meanwhile && finished && quick.settled && quick.value === 42
  );
  let rejected = false;
  try {
    await settleWithin(Promise.reject(new Error("boom")), 1000);
  } catch {
    rejected = true;
  }
  check("settleWithin: a rejection inside the window rejects", rejected);
}

finishSelftest();
