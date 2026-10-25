import type { RadiationHour } from "./solarModel.types.ts";

/**
 * "Snow may be on the panels" from the forecast's own snow variables (ERA5-Land isn't available
 * live): snow depth above 1 cm, or at least 0.5 cm of snowfall in the past week. Only a gate — the
 * per-string production deficit decides how much (snowNowcast.ts), and in fitting the gated hours
 * are simply left out. `hours` must be consecutive; a missing hour counts as no snow.
 */
export function snowGateFlags(hours: (RadiationHour | undefined)[]): Uint8Array {
  const flags = new Uint8Array(hours.length);
  let weekSnowfallCm = 0;
  hours.forEach((hour, index) => {
    weekSnowfallCm += hour?.snowfallCm ?? 0;
    if (index >= SNOWFALL_WINDOW_HOURS) weekSnowfallCm -= hours[index - SNOWFALL_WINDOW_HOURS]?.snowfallCm ?? 0;
    const deepSnow = (hour?.snowDepthMetres ?? 0) > SNOW_DEPTH_GATE_METRES;
    // Tolerance: the running sum drifts by float rounding over thousands of hours
    flags[index] = deepSnow || weekSnowfallCm >= WEEK_SNOWFALL_GATE_CM - 1e-9 ? 1 : 0;
  });
  return flags;
}

const SNOWFALL_WINDOW_HOURS = 168;
const SNOW_DEPTH_GATE_METRES = 0.01;
const WEEK_SNOWFALL_GATE_CM = 0.5;
