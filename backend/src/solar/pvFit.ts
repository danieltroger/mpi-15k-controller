import { SUBSTEPS_PER_HOUR, unshadedMask } from "./pvModel.ts";
import { albedoAt, clearHourFlags, type StringTerms, type TermColumns } from "./pvFitColumns.ts";
import { fitBeamMask, type MaskSample } from "./pvFitMask.ts";
import { fitNonNegativePair } from "./pvFitScale.ts";
import { recencyWeight, seasonallyBalancedDecayWeights } from "./pvFitWeights.ts";
import type { SolarFitDataset, StringFitResult } from "./pvFit.types.ts";
import type { SolarStringKey } from "./solarModel.types.ts";

/**
 * Fits one string with its geometry fixed (owner-measured; free geometry scored within 0.3 % and
 * costs robustness): capacity k and sky factor by Huber-robust NNLS on the physical irradiance,
 * the shading mask from clear-ish 10-min bins, twice in alternation, then k and the sky factor
 * re-calibrated by plain least squares against the forecast archive — the mean is what the
 * planner needs. With a half-life, recent observations weigh more (seasonally balanced for k).
 */
export function fitSolarString(
  dataset: SolarFitDataset,
  stringKey: SolarStringKey,
  terms: StringTerms,
  options: { nowMs: number; mask_half_life_days: number }
): StringFitResult {
  const observations = dataset.strings[stringKey];
  const physicalTerms = terms.physical;
  const forecastTerms = terms.forecast;
  const bins = terms.bins;
  const clear = clearHourFlags(dataset);
  const fitHours: number[] = [];
  const clearHours: number[] = [];
  for (let hour = 0; hour < dataset.hourStartMs.length; hour++) {
    if (!observations.usable[hour]) continue;
    fitHours.push(hour);
    if (clear[hour]) clearHours.push(hour);
  }
  const balancedWeights =
    options.mask_half_life_days > 0
      ? seasonallyBalancedDecayWeights(
          dataset.hourStartMs,
          observations.usable,
          options.nowMs,
          options.mask_half_life_days
        )
      : undefined;
  const context: FitContext = { dataset, observations, bins, balancedWeights };

  let mask = unshadedMask();
  let physical = fitScale(context, physicalTerms, clearHours, mask, {
    iterations: 8,
    weighted: false,
    capSkyFactor: true,
  });
  let maskFit = { mask, sampleCounts: [] as number[][] };
  for (let round = 0; round < 2; round++) {
    maskFit = fitBeamMask(maskSamples(context, physicalTerms, clearHours, physical, options));
    mask = maskFit.mask;
    physical = fitScale(context, physicalTerms, fitHours, mask, { iterations: 8, weighted: true, capSkyFactor: true });
  }
  // Uncapped: a forecast sky factor above 1 is calibration ("forecast says diffuse" = some sun on
  // average), and capping it at 1.5 without re-solving k cost string 1 2.6 % of its energy
  const forecast = fitScale(context, forecastTerms, fitHours, mask, {
    iterations: 1,
    weighted: true,
    capSkyFactor: false,
  });
  return {
    physical_k: physical.k,
    physical_sky_factor: physical.sky_factor,
    forecast_k: forecast.k,
    forecast_sky_factor: forecast.sky_factor,
    mask,
    mask_sample_counts: maskFit.sampleCounts,
    fit_hours: fitHours.length,
  };
}

type FitContext = {
  dataset: SolarFitDataset;
  observations: SolarFitDataset["strings"][SolarStringKey];
  bins: Int16Array;
  balancedWeights: Float64Array | undefined;
};

/** pv ≈ k·(beam·mask + albedo·ground) + (k·sky_factor)·isotropic, no ceiling (it never binds in fitting data) */
function fitScale(
  context: FitContext,
  terms: TermColumns,
  hours: number[],
  mask: number[][],
  options: { iterations: number; weighted: boolean; capSkyFactor: boolean }
): { k: number; sky_factor: number } {
  const flatMask = mask.flat();
  const directColumn = new Float64Array(hours.length);
  const diffuseColumn = new Float64Array(hours.length);
  const target = new Float64Array(hours.length);
  const baseWeights = options.weighted && context.balancedWeights ? new Float64Array(hours.length) : undefined;
  hours.forEach((hour, row) => {
    const albedo = albedoAt(context.dataset, hour);
    let direct = 0;
    let diffuse = 0;
    for (let substep = 0; substep < SUBSTEPS_PER_HOUR; substep++) {
      const index = hour * SUBSTEPS_PER_HOUR + substep;
      direct += terms.beam[index] * flatMask[context.bins[index]] + albedo * terms.groundPerAlbedo[index];
      diffuse += terms.isotropic[index];
    }
    directColumn[row] = direct / SUBSTEPS_PER_HOUR;
    diffuseColumn[row] = diffuse / SUBSTEPS_PER_HOUR;
    target[row] = context.observations.hourlyWatts[hour];
    if (baseWeights && context.balancedWeights) baseWeights[row] = context.balancedWeights[hour];
  });
  const { coefficients } = fitNonNegativePair(directColumn, diffuseColumn, target, {
    iterations: options.iterations,
    baseWeights,
  });
  const skyFactor = Math.max(coefficients[1] / Math.max(coefficients[0], 1e-6), 0);
  return {
    k: coefficients[0],
    sky_factor: options.capSkyFactor ? Math.min(skyFactor, MAX_PHYSICAL_SKY_FACTOR) : skyFactor,
  };
}

/** Per usable 10-min bin: the beam transmission that explains the observed power, weighted by beam power × recency. */
function maskSamples(
  context: FitContext,
  terms: TermColumns,
  clearHours: number[],
  coefficients: { k: number; sky_factor: number },
  recency: { nowMs: number; mask_half_life_days: number }
): MaskSample[] {
  const samples: MaskSample[] = [];
  for (const hour of clearHours) {
    const albedo = albedoAt(context.dataset, hour);
    const ageWeight =
      recency.mask_half_life_days > 0
        ? recencyWeight(context.dataset.hourStartMs[hour], recency.nowMs, recency.mask_half_life_days)
        : 1;
    for (let substep = 0; substep < SUBSTEPS_PER_HOUR; substep++) {
      const index = hour * SUBSTEPS_PER_HOUR + substep;
      const observed = context.observations.substepWatts[index];
      if (!(terms.beam[index] > MIN_BEAM_FOR_MASK) || !Number.isFinite(observed)) continue;
      const beamPower = coefficients.k * terms.beam[index];
      const otherPower =
        coefficients.k * (coefficients.sky_factor * terms.isotropic[index] + albedo * terms.groundPerAlbedo[index]);
      samples.push({
        azimuthDegrees: context.dataset.sunAzimuthDegrees[index],
        elevationDegrees: context.dataset.sunElevationDegrees[index],
        transmission: (observed - otherPower) / beamPower,
        weight: beamPower * ageWeight,
      });
    }
  }
  return samples;
}

/** A physical sky above 1.5× an open sky is nonsense; the clip only guards the physics fit */
const MAX_PHYSICAL_SKY_FACTOR = 1.5;
/** W/m² of plane-of-array beam below which a 10-min bin says nothing about shading */
const MIN_BEAM_FOR_MASK = 80;
