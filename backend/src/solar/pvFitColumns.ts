import { ELEVATION_BIN_COUNT, maskBin, poaTerms, SUBSTEPS_PER_HOUR, type HourSun } from "./pvModel.ts";
import type { RadiationColumns, SolarFitDataset, StringGeometry } from "./pvFit.types.ts";

/**
 * Columnar versions of the pvModel.ts maths for the fit: the plane-of-array terms of every hour
 * computed once per (geometry, irradiance source), so the fit's iterations only redo cheap sums.
 */
export function computeTermColumns(
  dataset: SolarFitDataset,
  radiation: RadiationColumns,
  geometry: StringGeometry
): TermColumns {
  const hourCount = dataset.hourStartMs.length;
  const beam = new Float64Array(hourCount * SUBSTEPS_PER_HOUR);
  const isotropic = new Float64Array(hourCount * SUBSTEPS_PER_HOUR);
  const groundPerAlbedo = new Float64Array(hourCount * SUBSTEPS_PER_HOUR);
  for (let hour = 0; hour < hourCount; hour++) {
    const terms = poaTerms(
      hourSunAt(dataset, hour),
      {
        globalHorizontal: radiation.globalHorizontal[hour],
        diffuseHorizontal: radiation.diffuseHorizontal[hour],
        directHorizontal: radiation.directHorizontal[hour],
      },
      geometry.tilt_degrees,
      geometry.azimuth_degrees
    );
    beam.set(terms.beam, hour * SUBSTEPS_PER_HOUR);
    isotropic.set(terms.isotropic, hour * SUBSTEPS_PER_HOUR);
    groundPerAlbedo.set(terms.groundPerAlbedo, hour * SUBSTEPS_PER_HOUR);
  }
  return { beam, isotropic, groundPerAlbedo };
}

export type TermColumns = { beam: Float64Array; isotropic: Float64Array; groundPerAlbedo: Float64Array };

/** Everything geometry-dependent for one string, computed once per refit and shared by fit and gates */
export type StringTerms = { physical: TermColumns; forecast: TermColumns; bins: Int16Array };

export function prepareStringTerms(dataset: SolarFitDataset, geometry: StringGeometry, bins: Int16Array): StringTerms {
  return {
    physical: computeTermColumns(dataset, dataset.physical, geometry),
    forecast: computeTermColumns(dataset, dataset.forecast, geometry),
    bins,
  };
}

export function hourSunAt(dataset: SolarFitDataset, hour: number): HourSun {
  const offset = hour * SUBSTEPS_PER_HOUR;
  return {
    azimuthDegrees: Array.from(dataset.sunAzimuthDegrees.subarray(offset, offset + SUBSTEPS_PER_HOUR)),
    elevationDegrees: Array.from(dataset.sunElevationDegrees.subarray(offset, offset + SUBSTEPS_PER_HOUR)),
    extraterrestrial: dataset.extraterrestrial[hour],
  };
}

/** Flat mask bin (azimuthBin × ELEVATION_BIN_COUNT + elevationBin) of every sub-step */
export function maskBinColumn(dataset: SolarFitDataset): Int16Array {
  const bins = new Int16Array(dataset.sunAzimuthDegrees.length);
  for (let substep = 0; substep < bins.length; substep++) {
    const { azimuthBin, elevationBin } = maskBin(
      dataset.sunAzimuthDegrees[substep],
      dataset.sunElevationDegrees[substep]
    );
    bins[substep] = azimuthBin * ELEVATION_BIN_COUNT + elevationBin;
  }
  return bins;
}

export function albedoAt(dataset: SolarFitDataset, hour: number): number {
  return dataset.snowOnGround[hour] ? 0.6 : 0.2;
}

/** Hour-mean power of the given hours for one set of coefficients (the ceiling applies per sub-step). */
export function predictHourlyWatts(
  dataset: SolarFitDataset,
  terms: TermColumns,
  bins: Int16Array,
  coefficients: { k: number; sky_factor: number; mask: number[][]; ceiling_watts: number },
  hours: Iterable<number>
): Map<number, number> {
  const flatMask = coefficients.mask.flat();
  const predictions = new Map<number, number>();
  for (const hour of hours) {
    const albedo = albedoAt(dataset, hour);
    let sum = 0;
    for (let substep = 0; substep < SUBSTEPS_PER_HOUR; substep++) {
      const index = hour * SUBSTEPS_PER_HOUR + substep;
      const planeOfArray =
        terms.beam[index] * flatMask[bins[index]] +
        coefficients.sky_factor * terms.isotropic[index] +
        albedo * terms.groundPerAlbedo[index];
      sum += Math.min(coefficients.k * planeOfArray, coefficients.ceiling_watts);
    }
    predictions.set(hour, sum / SUBSTEPS_PER_HOUR);
  }
  return predictions;
}

/**
 * Clear-sky screening on the physical source: GHI against the Haurwitz clear-sky model, plus the
 * diffuse fraction. Clear-ish hours are where the beam dominates and the mask is identifiable.
 */
export function clearHourFlags(dataset: SolarFitDataset): Uint8Array {
  const hourCount = dataset.hourStartMs.length;
  const clear = new Uint8Array(hourCount);
  for (let hour = 0; hour < hourCount; hour++) {
    let clearSkyGlobal = 0;
    for (let substep = 0; substep < SUBSTEPS_PER_HOUR; substep++) {
      const sinElevation = Math.max(
        Math.sin((dataset.sunElevationDegrees[hour * SUBSTEPS_PER_HOUR + substep] * Math.PI) / 180),
        0
      );
      clearSkyGlobal += 1098 * sinElevation * Math.exp(-0.057 / Math.max(sinElevation, 0.01));
    }
    clearSkyGlobal /= SUBSTEPS_PER_HOUR;
    const globalHorizontal = dataset.physical.globalHorizontal[hour];
    const clearness = clearSkyGlobal > 20 ? globalHorizontal / clearSkyGlobal : 0;
    const diffuseFraction =
      globalHorizontal > 5 ? dataset.physical.diffuseHorizontal[hour] / Math.max(globalHorizontal, 1) : 1;
    clear[hour] = clearness > 0.65 && diffuseFraction < 0.4 ? 1 : 0;
  }
  return clear;
}
