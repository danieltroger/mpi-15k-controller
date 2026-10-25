/**
 * The "PV stalled" signature (same as the inverter-stuck alert's): a 10-min bin with ≤ 20 W from
 * both MPPTs while a string sits at ≥ 300 V open circuit in daylight. Production that is merely
 * low (shade, cloud, snow) still draws current and pulls the voltage down; a stalled MPPT doesn't.
 * Over 2.5 years it caught 35 of 41 known outage hours with 7 hours of false positives.
 */
export function isStalledBin(bin: {
  mppt1Watts: number;
  mppt2Watts: number;
  mppt1Volts: number;
  mppt2Volts: number;
  sunElevationDegrees: number;
}): boolean {
  return (
    bin.mppt1Watts + bin.mppt2Watts <= STALLED_MAX_TOTAL_WATTS &&
    maxIgnoringNaN(bin.mppt1Volts, bin.mppt2Volts) >= STALLED_MIN_STRING_VOLTS &&
    bin.sunElevationDegrees > STALLED_MIN_SUN_ELEVATION_DEGREES
  );
}

const STALLED_MAX_TOTAL_WATTS = 20;
const STALLED_MIN_STRING_VOLTS = 300;
const STALLED_MIN_SUN_ELEVATION_DEGREES = 3;

function maxIgnoringNaN(first: number, second: number): number {
  if (Number.isNaN(first)) return second;
  if (Number.isNaN(second)) return first;
  return Math.max(first, second);
}
