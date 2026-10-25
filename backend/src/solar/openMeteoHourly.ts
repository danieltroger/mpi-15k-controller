import { z } from "zod";
import type { RadiationHour } from "./solarModel.types.ts";

/**
 * Parses any open-meteo hourly payload (live forecast, historical-forecast archive, satellite
 * archive) into RadiationHours keyed by the START of the hour each value averages.
 *
 * The alignment is the whole point of this function: open-meteo radiation is "averaged over the
 * past hour", labelled at the END of that hour, while Influx GROUP BY time(1h) labels the start.
 * Pairing them naively put every forecast an hour early (and cost the old fit ~0.14 of R²).
 * Hours with any null irradiance are dropped.
 */
export function parseOpenMeteoHourly(payload: unknown): RadiationHour[] {
  const { hourly } = openMeteoHourlySchema.parse(payload);
  const hours: RadiationHour[] = [];
  hourly.time.forEach((label, index) => {
    const globalHorizontal = hourly.shortwave_radiation[index];
    const directHorizontal = hourly.direct_radiation[index];
    const diffuseHorizontal = hourly.diffuse_radiation[index];
    if (globalHorizontal == null || directHorizontal == null || diffuseHorizontal == null) return;
    const labelMs = Date.parse(`${label}:00Z`);
    if (!Number.isFinite(labelMs)) throw new Error(`open-meteo returned an unparseable hour label "${label}"`);
    const hour: RadiationHour = {
      hourStartMs: labelMs - 3600_000,
      globalHorizontal,
      directHorizontal,
      diffuseHorizontal,
    };
    const snowfallCm = hourly.snowfall?.[index];
    const snowDepthMetres = hourly.snow_depth?.[index];
    if (snowfallCm != null) hour.snowfallCm = snowfallCm;
    if (snowDepthMetres != null) hour.snowDepthMetres = snowDepthMetres;
    hours.push(hour);
  });
  return hours;
}

const nullableNumbers = z.array(z.number().nullable());

const openMeteoHourlySchema = z.object({
  hourly: z.object({
    time: z.array(z.string()),
    shortwave_radiation: nullableNumbers,
    direct_radiation: nullableNumbers,
    diffuse_radiation: nullableNumbers,
    snowfall: nullableNumbers.optional(),
    snow_depth: nullableNumbers.optional(),
  }),
});

/** Variables requested from every source that has them (the satellite has no snow) */
export const RADIATION_VARIABLES = "shortwave_radiation,direct_radiation,diffuse_radiation";
export const SNOW_VARIABLES = "snowfall,snow_depth";
