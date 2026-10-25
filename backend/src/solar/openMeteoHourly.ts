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
  const hourly = hourlySection(payload);
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

/** Variables requested from every source that has them (the satellite has no snow) */
export const RADIATION_VARIABLES = "shortwave_radiation,direct_radiation,diffuse_radiation";
export const SNOW_VARIABLES = "snowfall,snow_depth";

type NullableNumbers = (number | null)[];

type OpenMeteoHourly = {
  time: string[];
  shortwave_radiation: NullableNumbers;
  direct_radiation: NullableNumbers;
  diffuse_radiation: NullableNumbers;
  snowfall?: NullableNumbers;
  snow_depth?: NullableNumbers;
};

/**
 * Narrows the payload by hand rather than with zod: this module also runs in the refit child
 * process, which loads no npm packages (see solarRefitRunner.ts).
 */
function hourlySection(payload: unknown): OpenMeteoHourly {
  const hourly = isRecord(payload) ? payload.hourly : undefined;
  if (!isRecord(hourly) || !isStringArray(hourly.time)) {
    throw new Error(`open-meteo response without an hourly.time array: ${JSON.stringify(payload).slice(0, 200)}`);
  }
  return {
    time: hourly.time,
    shortwave_radiation: nullableNumbersOf(hourly, "shortwave_radiation", true) ?? [],
    direct_radiation: nullableNumbersOf(hourly, "direct_radiation", true) ?? [],
    diffuse_radiation: nullableNumbersOf(hourly, "diffuse_radiation", true) ?? [],
    snowfall: nullableNumbersOf(hourly, "snowfall", false),
    snow_depth: nullableNumbersOf(hourly, "snow_depth", false),
  };
}

function nullableNumbersOf(
  hourly: Record<string, unknown>,
  name: string,
  required: boolean
): NullableNumbers | undefined {
  const values = hourly[name];
  if (values === undefined && !required) return undefined;
  if (!Array.isArray(values) || !values.every(value => value === null || typeof value === "number")) {
    throw new Error(`open-meteo response has no usable hourly.${name}`);
  }
  return values as NullableNumbers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(entry => typeof entry === "string");
}
