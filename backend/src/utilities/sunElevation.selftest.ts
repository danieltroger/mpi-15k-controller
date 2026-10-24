/**
 * Self-test for sunElevation.ts. Run from backend/ with:
 *   yarn node src/utilities/sunElevation.selftest.ts
 *
 * Reference values come from an independent implementation (Meeus, Astronomical Algorithms
 * ch. 25 solar coordinates + ch. 12 sidereal time, i.e. right ascension instead of the equation
 * of time), computed for the Örebro site the incident report uses (59.25 N, 15.22 E).
 */
import { sunElevationDegrees } from "./sunElevation.ts";

const LATITUDE = 59.25;
const LONGITUDE = 15.22;

let failures = 0;
function checkNear(name: string, actual: number, expected: number, tolerance: number) {
  const ok = Math.abs(actual - expected) <= tolerance;
  if (!ok) {
    failures++;
    console.error(`FAIL ${name}: expected ${expected} ± ${tolerance}, got ${actual.toFixed(3)}`);
  } else {
    console.log(`ok   ${name} (${actual.toFixed(3)})`);
  }
}

const referenceElevations = [
  { label: "summer solstice, solar noon", iso: "2026-06-21T11:00:00Z", elevation: 54.188 },
  { label: "winter solstice, solar noon", iso: "2026-12-21T11:00:00Z", elevation: 7.311 },
  { label: "spring equinox day, solar noon", iso: "2026-03-20T11:00:00Z", elevation: 30.676 },
  { label: "incident morning, around sunrise", iso: "2026-10-21T05:50:00Z", elevation: -0.95 },
  { label: "incident morning, Rule A's backtested firing time", iso: "2026-10-21T06:50:00Z", elevation: 5.91 },
  { label: "midsummer early morning", iso: "2026-07-01T03:00:00Z", elevation: 5.563 },
  { label: "leap day forenoon", iso: "2024-02-29T09:30:00Z", elevation: 20.026 },
  { label: "winter solstice, solar midnight", iso: "2026-12-21T23:00:00Z", elevation: -54.185 },
];
for (const reference of referenceElevations) {
  checkNear(
    reference.label,
    sunElevationDegrees(+new Date(reference.iso), LATITUDE, LONGITUDE),
    reference.elevation,
    0.1
  );
}

// Physical check independent of any implementation: the noon maximum is 90° − latitude + declination,
// with the declination at ±23.44° on the solstices and ~0 at the equinox.
const noonMaxima = [
  { day: "2026-06-21", declination: 23.44, solarNoonUtcMinute: 661 },
  { day: "2026-12-21", declination: -23.44, solarNoonUtcMinute: 657 },
  { day: "2026-03-20", declination: -0.06, solarNoonUtcMinute: 667 },
];
for (const { day, declination, solarNoonUtcMinute } of noonMaxima) {
  const dayStartMs = +new Date(`${day}T00:00:00Z`);
  let highestElevation = -90;
  let highestAtMinute = 0;
  for (let minute = 0; minute < 24 * 60; minute++) {
    const elevation = sunElevationDegrees(dayStartMs + minute * 60_000, LATITUDE, LONGITUDE);
    if (elevation > highestElevation) {
      highestElevation = elevation;
      highestAtMinute = minute;
    }
  }
  checkNear(`${day} noon maximum is 90 − latitude + declination`, highestElevation, 90 - LATITUDE + declination, 0.5);
  // Longitude + equation of time: solar noon at 15.22 E lands about an hour before 12:00 UTC
  checkNear(`${day} solar noon minute (UTC)`, highestAtMinute, solarNoonUtcMinute, 3);
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll sun elevation checks passed");
