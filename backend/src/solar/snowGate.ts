/**
 * "Snow may be on the panels" from the forecast's own snow variables (ERA5-Land isn't available
 * live): snow depth above 1 cm, or at least 0.5 cm of snowfall in the past week. Only a gate — the
 * per-string production deficit decides how much (snowNowcast.ts); fitting and the accuracy week
 * simply leave gated hours out. Both arrays cover the same consecutive hours; NaN = no data = no snow.
 */
export function snowGateFlags(snowfallCm: ArrayLike<number>, snowDepthMetres: ArrayLike<number>): Uint8Array {
  const flags = new Uint8Array(snowfallCm.length);
  let weekSnowfallCm = 0;
  for (let hour = 0; hour < snowfallCm.length; hour++) {
    weekSnowfallCm += finiteOrZero(snowfallCm[hour]);
    if (hour >= SNOWFALL_WINDOW_HOURS) weekSnowfallCm -= finiteOrZero(snowfallCm[hour - SNOWFALL_WINDOW_HOURS]);
    const deepSnow = finiteOrZero(snowDepthMetres[hour]) > SNOW_DEPTH_GATE_METRES;
    // Tolerance: the running sum drifts by float rounding over thousands of hours
    flags[hour] = deepSnow || weekSnowfallCm >= WEEK_SNOWFALL_GATE_CM - 1e-9 ? 1 : 0;
  }
  return flags;
}

const SNOWFALL_WINDOW_HOURS = 168;
const SNOW_DEPTH_GATE_METRES = 0.01;
const WEEK_SNOWFALL_GATE_CM = 0.5;

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}
