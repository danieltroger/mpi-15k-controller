/**
 * Self-test for the physical PV model's pure parts: sun position, the open-meteo alignment,
 * TypeScript-vs-Python parity on real inputs, the forecast assembly, the snow nowcast and the
 * weekly accuracy rule. Run from backend/ with:
 *   yarn node src/solar/pvModel.selftest.ts
 */
import { readFileSync } from "fs";
import { sunPosition } from "../utilities/sunPosition.ts";
import { parseOpenMeteoHourly } from "./openMeteoHourly.ts";
import { hourSun, poaTerms, stringSubstepWatts, unshadedMask, type StringCoefficients } from "./pvModel.ts";
import { buildSolarForecast } from "./solarForecastModel.ts";
import { nowcastRatio, snowNowcastFactor } from "./snowNowcast.ts";
import { snowGateFlags } from "./snowGate.ts";
import { judgeForecastWeek } from "./solarForecastAccuracyRule.ts";
import { localDayBounds } from "./solarForecastAccuracy.ts";
import type { RadiationHour } from "./solarModel.types.ts";

const fails: string[] = [];
function check(name: string, condition: boolean, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}: ${name} ${detail}`);
  if (!condition) fails.push(name);
}

const LATITUDE = 59.246761;
const LONGITUDE = 15.223236;
const HOUR_MS = 3600_000;

// ---------- sun position ----------
{
  // Solar noon at the summer solstice: 90 − 59.25 + 23.44 = 54.19°, due south
  const summer = sunPosition(Date.parse("2026-06-21T11:01:00Z"), LATITUDE, LONGITUDE);
  check(
    "sun: solstice noon elevation",
    Math.abs(summer.geometricElevationDegrees - 54.19) < 0.05,
    `(${summer.geometricElevationDegrees.toFixed(3)}°)`
  );
  check(
    "sun: solstice noon is due south",
    Math.abs(summer.azimuthDegrees - 180) < 1,
    `(${summer.azimuthDegrees.toFixed(2)}°)`
  );
  // Winter solstice noon: 7.31° geometric, refraction lifts it ~0.12°
  const winter = sunPosition(Date.parse("2026-12-21T11:00:00Z"), LATITUDE, LONGITUDE);
  check(
    "sun: winter noon apparent elevation includes refraction",
    Math.abs(winter.apparentElevationDegrees - 7.43) < 0.05 &&
      winter.apparentElevationDegrees > winter.geometricElevationDegrees,
    `(${winter.apparentElevationDegrees.toFixed(3)}°)`
  );
  const equinoxMorning = sunPosition(Date.parse("2026-03-20T06:00:00Z"), LATITUDE, LONGITUDE);
  check(
    "sun: equinox morning sun in the east",
    Math.abs(equinoxMorning.azimuthDegrees - 101.6) < 0.5,
    `(${equinoxMorning.azimuthDegrees.toFixed(2)}°)`
  );
}

// ---------- open-meteo alignment: a label is the END of its averaging hour ----------
{
  const hours = parseOpenMeteoHourly({
    hourly: {
      time: ["2026-06-21T12:00", "2026-06-21T13:00", "2026-06-21T14:00"],
      shortwave_radiation: [700, null, 500],
      direct_radiation: [500, 400, 300],
      diffuse_radiation: [200, 150, 200],
      snowfall: [0, 0, null],
    },
  });
  check("parse: null irradiance hours dropped", hours.length === 2, `(${hours.length})`);
  check(
    "parse: value labelled 12:00 covers 11:00–12:00",
    hours[0].hourStartMs === Date.parse("2026-06-21T11:00:00Z"),
    new Date(hours[0].hourStartMs).toISOString()
  );
  check(
    "parse: optional snow variables kept when present, absent otherwise",
    hours[0].snowfallCm === 0 && hours[1].snowfallCm === undefined
  );
}

// ---------- parity with the Python research prototype on real inputs ----------
{
  type ReferenceHour = Omit<RadiationHour, "snowfallCm" | "snowDepthMetres"> & {
    snowOnGround: boolean;
    sunAzimuthDegrees: number[];
    sunElevationDegrees: number[];
  };
  type ReferenceString = {
    tilt_degrees: number;
    azimuth_degrees: number;
    coefficients: StringCoefficients;
    expected_substep_watts: number[][];
  };
  const reference = JSON.parse(
    readFileSync(new URL("./fixtures/pvModelPythonReference.json", import.meta.url), { encoding: "utf-8" })
  ) as { hours: ReferenceHour[]; strings: Record<"string1" | "string2", ReferenceString> };
  let maxSunError = 0;
  let maxWattsError = 0;
  let energyTypeScript = 0;
  let energyPython = 0;
  for (const [hourIndex, hour] of reference.hours.entries()) {
    const sun = hourSun(hour.hourStartMs, LATITUDE, LONGITUDE);
    for (let substep = 0; substep < 6; substep++) {
      maxSunError = Math.max(
        maxSunError,
        Math.abs(sun.azimuthDegrees[substep] - hour.sunAzimuthDegrees[substep]),
        Math.abs(sun.elevationDegrees[substep] - hour.sunElevationDegrees[substep])
      );
    }
    for (const stringKey of ["string1", "string2"] as const) {
      const spec = reference.strings[stringKey];
      const watts = stringSubstepWatts(
        poaTerms(sun, hour, spec.tilt_degrees, spec.azimuth_degrees),
        sun,
        spec.coefficients,
        hour.snowOnGround
      );
      watts.forEach((value, substep) => {
        const expected = spec.expected_substep_watts[hourIndex][substep];
        maxWattsError = Math.max(maxWattsError, Math.abs(value - expected));
        energyTypeScript += value;
        energyPython += expected;
      });
    }
  }
  check("parity: sun positions match the prototype", maxSunError < 1e-6, `(max ${maxSunError.toExponential(2)}°)`);
  check(
    "parity: sub-step watts match the prototype within 0.01 W",
    maxWattsError < 0.01,
    `(max ${maxWattsError.toFixed(5)} W)`
  );
  check(
    "parity: 4-day energy matches within 0.01 %",
    Math.abs(energyTypeScript / energyPython - 1) < 1e-4,
    `(${(energyTypeScript / 6000).toFixed(2)} vs ${(energyPython / 6000).toFixed(2)} kWh)`
  );
}

// ---------- physics sanity ----------
{
  const nightSun = hourSun(Date.parse("2026-12-21T22:00:00Z"), LATITUDE, LONGITUDE);
  const night = poaTerms(nightSun, { globalHorizontal: 0, diffuseHorizontal: 0, directHorizontal: 0 }, 36, 180);
  check(
    "poa: nothing at night",
    [...night.beam, ...night.isotropic, ...night.groundPerAlbedo].every(value => value === 0)
  );
  const noonSun = hourSun(Date.parse("2026-03-20T10:30:00Z"), LATITUDE, LONGITUDE);
  const clearNoon = { globalHorizontal: 550, diffuseHorizontal: 90, directHorizontal: 460 };
  const southTilted = poaTerms(noonSun, clearNoon, 36, 180);
  const northTilted = poaTerms(noonSun, clearNoon, 36, 0);
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
  check(
    "poa: equinox noon beam on a south tilt beats horizontal",
    sum(southTilted.beam) / 6 > clearNoon.directHorizontal
  );
  check("poa: a north-facing 36° panel sees no beam at equinox noon", sum(northTilted.beam) === 0);
  const capped = stringSubstepWatts(
    southTilted,
    noonSun,
    { k: 30, sky_factor: 1, mask: unshadedMask(), ceiling_watts: 10_580 },
    false
  );
  check(
    "model: power never exceeds the current-cap ceiling",
    capped.every(value => value <= 10_580)
  );
}

// ---------- forecast assembly: sub-step lookup, nowcast on future hours only ----------
{
  const nowMs = Date.parse("2026-02-10T12:20:00Z");
  const firstHourMs = nowMs - 72 * HOUR_MS - (nowMs % HOUR_MS);
  const radiationHours: RadiationHour[] = [];
  for (let hourStartMs = firstHourMs; hourStartMs < nowMs + 48 * HOUR_MS; hourStartMs += HOUR_MS) {
    radiationHours.push({
      hourStartMs,
      globalHorizontal: 300,
      diffuseHorizontal: 100,
      directHorizontal: 200,
      snowfallCm: 0.2,
      snowDepthMetres: 0.15,
    });
  }
  const coefficients: StringCoefficients = { k: 9, sky_factor: 1, mask: unshadedMask(), ceiling_watts: 10_580 };
  const strings = {
    string1: { tilt_degrees: 36, azimuth_degrees: 180, coefficients },
    string2: { tilt_degrees: 45, azimuth_degrees: 300, coefficients },
  };
  const unscaled = buildSolarForecast({
    radiationHours,
    nowMs,
    latitude: LATITUDE,
    longitude: LONGITUDE,
    strings,
    recentActual: undefined,
  });
  // String 1 snow-covered (10 % of the model), string 2 scraped clear (100 %)
  const recentActual = new Map<number, { string1: number; string2: number }>();
  for (const hour of unscaled.hours) {
    if (hour.hourStartMs < nowMs - HOUR_MS)
      recentActual.set(hour.hourStartMs, { string1: hour.string1Watts * 0.1, string2: hour.string2Watts });
  }
  const scaled = buildSolarForecast({
    radiationHours,
    nowMs,
    latitude: LATITUDE,
    longitude: LONGITUDE,
    strings,
    recentActual,
  });
  const tomorrowNoonMs = Date.parse("2026-02-11T11:30:00Z");
  const tomorrowUnscaled = unscaled.hours.find(hour => hour.hourStartMs === tomorrowNoonMs - 30 * 60_000);
  const tomorrowScaled = scaled.hours.find(hour => hour.hourStartMs === tomorrowNoonMs - 30 * 60_000);
  check(
    "forecast: string 1 nowcast learns the snow deficit",
    Math.abs(scaled.nowcast.string1.ratio - 0.1) < 0.01,
    `(${scaled.nowcast.string1.ratio.toFixed(3)})`
  );
  check(
    "forecast: string 2 nowcast stays at 1 when it produces as modelled",
    Math.abs(scaled.nowcast.string2.ratio - 1) < 0.01
  );
  check(
    "forecast: per string — the snow-covered string is scaled, the clear one is not",
    !!tomorrowScaled &&
      !!tomorrowUnscaled &&
      tomorrowScaled.string1Watts < tomorrowUnscaled.string1Watts * 0.5 &&
      Math.abs(tomorrowScaled.string2Watts - tomorrowUnscaled.string2Watts) < 1
  );
  const substepHourMs = Date.parse("2026-02-11T10:00:00Z");
  const hourValues = Array.from({ length: 6 }, (_, substep) => scaled.wattsAt(substepHourMs + substep * 600_000 + 1));
  check(
    "forecast: wattsAt resolves 10-min sub-steps within the hour",
    new Set(hourValues.map(value => value.toFixed(3))).size === 6
  );
  check("forecast: wattsAt is 0 outside the range", scaled.wattsAt(nowMs + 30 * 24 * HOUR_MS) === 0);
}

// ---------- snow nowcast ----------
{
  check(
    "nowcast: gate closed means no correction",
    snowNowcastFactor({ ratio: 0.1, gateOpen: false, leadHours: 5 }) === 1
  );
  check("nowcast: never corrects upwards", snowNowcastFactor({ ratio: 1.6, gateOpen: true, leadHours: 5 }) === 1);
  const soon = snowNowcastFactor({ ratio: 0.2, gateOpen: true, leadHours: 1 });
  const later = snowNowcastFactor({ ratio: 0.2, gateOpen: true, leadHours: 72 });
  check(
    "nowcast: relaxes toward 1 with lead time",
    soon < 0.25 && later > 0.65 && later < 0.75,
    `(${soon.toFixed(3)} → ${later.toFixed(3)})`
  );
  check("nowcast: no informative hours → neutral", nowcastRatio([{ actualWatts: 0, modelWatts: 100 }]) === 1);
  const recovering = nowcastRatio([
    ...Array.from({ length: 20 }, () => ({ actualWatts: 50, modelWatts: 1000 })),
    ...Array.from({ length: 8 }, () => ({ actualWatts: 1000, modelWatts: 1000 })),
  ]);
  check("nowcast: snow sliding off is learned within a day of sun", recovering > 0.5, `(${recovering.toFixed(3)})`);
  const gate = snowGateFlags([
    { hourStartMs: 0, globalHorizontal: 0, diffuseHorizontal: 0, directHorizontal: 0, snowfallCm: 0.6 },
    ...Array.from({ length: 170 }, (_, index) => ({
      hourStartMs: (index + 1) * HOUR_MS,
      globalHorizontal: 0,
      diffuseHorizontal: 0,
      directHorizontal: 0,
      snowfallCm: 0,
    })),
  ]);
  check(
    "snow gate: a week of fresh snowfall keeps it open, then it closes",
    gate[0] === 1 && gate[167] === 1 && gate[168] === 0
  );
}

// ---------- rolling-week accuracy rule ----------
{
  const thresholds = { min_ratio: 0.65, max_ratio: 1.5, max_error_share: 0.55 };
  const week = (actual: number, forecast: number) =>
    Array.from({ length: 7 }, (_, day) => ({
      date: `2026-05-0${day + 1}`,
      actual_kwh: actual,
      forecast_kwh: forecast,
    }));
  check("week rule: a normal week passes", judgeForecastWeek(week(52, 55), thresholds)?.alarm === false);
  check(
    "week rule: half the forecast for a sunny week alarms",
    judgeForecastWeek(week(25, 55), thresholds)?.alarm === true
  );
  check("week rule: dark weeks don't alarm on ratio alone", judgeForecastWeek(week(1, 3), thresholds)?.alarm === false);
  check(
    "week rule: under five valid days gives no verdict",
    judgeForecastWeek(week(25, 55).slice(0, 4), thresholds) === undefined
  );
}

// ---------- local day bounds across DST ----------
{
  const spring = localDayBounds("2026-03-29");
  const autumn = localDayBounds("2026-10-25");
  const normal = localDayBounds("2026-06-21");
  check("local day: DST spring day has 23 h", (spring.endMs - spring.startMs) / HOUR_MS === 23);
  check("local day: DST autumn day has 25 h", (autumn.endMs - autumn.startMs) / HOUR_MS === 25);
  check(
    "local day: summer day starts at 22:00 UTC",
    new Date(normal.startMs).toISOString() === "2026-06-20T22:00:00.000Z"
  );
}

console.log(fails.length ? `\n${fails.length} FAILURES: ${fails.join(", ")}` : "\nAll scenarios passed");
process.exit(fails.length ? 1 : 0);
