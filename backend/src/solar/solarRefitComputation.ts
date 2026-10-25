import { fitSolarString } from "./pvFit.ts";
import { SUBSTEPS_PER_HOUR } from "./pvModel.ts";
import { computeTermColumns, maskBinColumn, predictHourlyWatts, type TermColumns } from "./pvFitColumns.ts";
import type { SolarFitDataset, StringFitResult, StringGeometry } from "./pvFit.types.ts";
import type { SolarModelState, SolarStringKey } from "./solarModel.types.ts";

/**
 * Everything CPU-heavy about a refit, pure so it can run in the worker thread (and in selftests):
 * the candidate fit per string, plus the numbers the gates judge it by against the incumbent.
 */
export function computeSolarRefit(input: SolarRefitInput): SolarRefitOutput {
  const strings = {} as SolarRefitOutput["strings"];
  const forecastPredictions = {} as Record<
    SolarStringKey,
    { candidate: Map<number, number>; incumbent?: Map<number, number> }
  >;
  const bins = maskBinColumn(input.dataset);
  const trailingYearHours = hoursSince(input.dataset, input.nowMs - 365 * 86_400_000);
  const levelWindowHours = hoursSince(input.dataset, input.nowMs - LEVEL_WINDOW_DAYS * 86_400_000);
  for (const stringKey of ["string1", "string2"] as const) {
    const geometry = input.geometry[stringKey];
    const fit = fitSolarString(input.dataset, stringKey, geometry, {
      nowMs: input.nowMs,
      halfLifeDays: input.halfLifeDays,
    });
    const physicalTerms = computeTermColumns(input.dataset, input.dataset.physical, geometry);
    const forecastTerms = computeTermColumns(input.dataset, input.dataset.forecast, geometry);
    const incumbent = input.incumbent?.strings[stringKey];
    const usable = input.dataset.strings[stringKey].usable;
    const usableYear = trailingYearHours.filter(hour => usable[hour]);
    forecastPredictions[stringKey] = {
      candidate: predictForecast(input.dataset, forecastTerms, bins, fit, geometry, usableYear),
      incumbent: incumbent
        ? predictHourlyWatts(
            input.dataset,
            forecastTerms,
            bins,
            {
              k: incumbent.forecast_k,
              sky_factor: incumbent.forecast_sky_factor,
              mask: incumbent.mask,
              ceiling_watts: geometry.ceiling_watts,
            },
            usableYear
          )
        : undefined,
    };
    strings[stringKey] = {
      fit,
      capacity_change: incumbent ? fit.physical_k / incumbent.physical_k - 1 : null,
      mask_energy_change: incumbent
        ? maskEnergyChange(input.dataset, physicalTerms, bins, fit, incumbent.mask, geometry, usableYear)
        : null,
      level: levelRatio(input.dataset, stringKey, forecastTerms, bins, fit, geometry, levelWindowHours),
    };
  }
  return {
    strings,
    trailing_year: trailingYearDailyErrors(input.dataset, forecastPredictions, trailingYearHours),
  };
}

export type SolarRefitInput = {
  dataset: SolarFitDataset;
  geometry: Record<SolarStringKey, StringGeometry>;
  nowMs: number;
  halfLifeDays: number | null;
  incumbent?: SolarModelState;
};

export type SolarRefitOutput = {
  strings: Record<
    SolarStringKey,
    {
      fit: StringFitResult;
      /** Candidate physical capacity relative to the incumbent's, −0.05 = 5 % lower */
      capacity_change: number | null;
      /** Trailing-year modelled energy with the candidate mask vs the incumbent mask (same capacity) */
      mask_energy_change: number | null;
      /** 90-day actual/candidate-model energy ratio, null when the window holds too little sun */
      level: { ratio: number | null; modelled_kwh: number };
    }
  >;
  /** Daily-kWh MAE (both strings) over the trailing year's fully usable days, forecast inputs */
  trailing_year: { days: number; candidate_mae_kwh: number | null; incumbent_mae_kwh: number | null };
};

/** Days of history behind the level check: long enough to average out weather, short enough to track a step */
const LEVEL_WINDOW_DAYS = 90;
/** Hours the model expects at least this much from a string count toward the level ratio */
const LEVEL_MIN_MODEL_WATTS = 300;
/** Minimum modelled energy for a meaningful level ratio (string 2 is smaller and heavily shaded) */
const LEVEL_MIN_MODELLED_KWH: Record<SolarStringKey, number> = { string1: 300, string2: 120 };

function predictForecast(
  dataset: SolarFitDataset,
  terms: TermColumns,
  bins: Int16Array,
  fit: StringFitResult,
  geometry: StringGeometry,
  hours: number[]
): Map<number, number> {
  return predictHourlyWatts(
    dataset,
    terms,
    bins,
    { k: fit.forecast_k, sky_factor: fit.forecast_sky_factor, mask: fit.mask, ceiling_watts: geometry.ceiling_watts },
    hours
  );
}

function maskEnergyChange(
  dataset: SolarFitDataset,
  terms: TermColumns,
  bins: Int16Array,
  fit: StringFitResult,
  incumbentMask: number[][],
  geometry: StringGeometry,
  hours: number[]
): number | null {
  const coefficients = {
    k: fit.physical_k,
    sky_factor: fit.physical_sky_factor,
    ceiling_watts: geometry.ceiling_watts,
  };
  const withCandidate = sumOf(predictHourlyWatts(dataset, terms, bins, { ...coefficients, mask: fit.mask }, hours));
  const withIncumbent = sumOf(
    predictHourlyWatts(dataset, terms, bins, { ...coefficients, mask: incumbentMask }, hours)
  );
  return withIncumbent > 0 ? withCandidate / withIncumbent - 1 : null;
}

function levelRatio(
  dataset: SolarFitDataset,
  stringKey: SolarStringKey,
  terms: TermColumns,
  bins: Int16Array,
  fit: StringFitResult,
  geometry: StringGeometry,
  windowHours: number[]
): { ratio: number | null; modelled_kwh: number } {
  const observations = dataset.strings[stringKey];
  const predictions = predictForecast(
    dataset,
    terms,
    bins,
    fit,
    geometry,
    windowHours.filter(hour => observations.usable[hour])
  );
  let actualWh = 0;
  let modelledWh = 0;
  for (const [hour, modelled] of predictions) {
    if (modelled <= LEVEL_MIN_MODEL_WATTS) continue;
    actualWh += observations.hourlyWatts[hour];
    modelledWh += modelled;
  }
  const modelledKwh = modelledWh / 1000;
  return {
    ratio: modelledKwh >= LEVEL_MIN_MODELLED_KWH[stringKey] ? actualWh / modelledWh : null,
    modelled_kwh: Math.round(modelledKwh),
  };
}

/**
 * Days (UTC+1, close enough to local for grouping daylight) where every daylight hour was usable
 * for every string — snow-gated days drop out, so winter noise can't fail the gate. A string with
 * no usable hour in the window (not wired yet) is left out rather than voiding every day.
 */
function trailingYearDailyErrors(
  dataset: SolarFitDataset,
  predictions: Record<SolarStringKey, { candidate: Map<number, number>; incumbent?: Map<number, number> }>,
  hours: number[]
): SolarRefitOutput["trailing_year"] {
  const activeStrings = (["string1", "string2"] as const).filter(
    stringKey => predictions[stringKey].candidate.size > 0
  );
  const days = new Map<number, { actual: number; candidate: number; incumbent: number; complete: boolean }>();
  for (const hour of hours) {
    const daylight = dataset.sunElevationDegrees
      .subarray(hour * SUBSTEPS_PER_HOUR, (hour + 1) * SUBSTEPS_PER_HOUR)
      .some(elevation => elevation > 0);
    if (!daylight) continue;
    const dayKey = Math.floor((dataset.hourStartMs[hour] + 3600_000) / 86_400_000);
    const day = days.get(dayKey) ?? { actual: 0, candidate: 0, incumbent: 0, complete: true };
    for (const stringKey of activeStrings) {
      const candidate = predictions[stringKey].candidate.get(hour);
      if (candidate === undefined) {
        day.complete = false;
        continue;
      }
      day.actual += dataset.strings[stringKey].hourlyWatts[hour];
      day.candidate += candidate;
      day.incumbent += predictions[stringKey].incumbent?.get(hour) ?? 0;
    }
    days.set(dayKey, day);
  }
  const completeDays = [...days.values()].filter(day => day.complete);
  if (!completeDays.length) return { days: 0, candidate_mae_kwh: null, incumbent_mae_kwh: null };
  const meanAbsoluteKwh = (pick: (day: (typeof completeDays)[number]) => number) =>
    completeDays.reduce((sum, day) => sum + Math.abs(pick(day) - day.actual), 0) / completeDays.length / 1000;
  return {
    days: completeDays.length,
    candidate_mae_kwh: meanAbsoluteKwh(day => day.candidate),
    incumbent_mae_kwh: predictions.string1.incumbent ? meanAbsoluteKwh(day => day.incumbent) : null,
  };
}

function hoursSince(dataset: SolarFitDataset, sinceMs: number): number[] {
  const hours: number[] = [];
  for (let hour = 0; hour < dataset.hourStartMs.length; hour++) {
    if (dataset.hourStartMs[hour] >= sinceMs) hours.push(hour);
  }
  return hours;
}

function sumOf(values: Map<number, number>): number {
  let sum = 0;
  for (const value of values.values()) sum += value;
  return sum;
}
