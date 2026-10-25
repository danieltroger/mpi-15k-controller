import { sunPosition } from "../utilities/sunPosition.ts";
import type { RadiationHour } from "./solarModel.types.ts";

/**
 * Per-string physical PV model (pure). One string's power in each 10-minute sub-step of an hour:
 *
 *   P = k · (beam·mask(sun azimuth, elevation) + sky_factor·isotropic diffuse + albedo·ground) , capped
 *
 * Every irradiance component is the open-meteo hour mean distributed over the hour in proportion to
 * sin(sun elevation), i.e. constant DNI within the hour — which is what matters at low sun, where
 * one sun position per hour would be badly wrong. There is deliberately no cell-temperature term:
 * in the 27-month backtest it made every variant worse (see the PR), so it is not modelled.
 */
export function stringSubstepWatts(
  terms: PoaTerms,
  sun: HourSun,
  coefficients: StringCoefficients,
  snowOnGround: boolean
): number[] {
  const albedo = snowOnGround ? SNOW_ALBEDO : GROUND_ALBEDO;
  const watts: number[] = [];
  for (let substep = 0; substep < SUBSTEPS_PER_HOUR; substep++) {
    const shade = maskTransmission(coefficients.mask, sun.azimuthDegrees[substep], sun.elevationDegrees[substep]);
    const planeOfArray =
      terms.beam[substep] * shade +
      coefficients.sky_factor * terms.isotropic[substep] +
      albedo * terms.groundPerAlbedo[substep];
    watts.push(Math.min(coefficients.k * planeOfArray, coefficients.ceiling_watts));
  }
  return watts;
}

export const SUBSTEPS_PER_HOUR = 6;
const SUBSTEP_MS = 3600_000 / SUBSTEPS_PER_HOUR;

/** Mask bins: compass sun azimuth 20°…340° in 10° steps, elevation finer near the horizon where shading lives */
export const AZIMUTH_BIN_EDGES: readonly number[] = Array.from({ length: 33 }, (_, binIndex) => 20 + 10 * binIndex);
export const ELEVATION_BIN_EDGES: readonly number[] = [0, 3, 6, 9, 12, 15, 20, 25, 30, 35, 40, 45, 50, 60];
export const AZIMUTH_BIN_COUNT = AZIMUTH_BIN_EDGES.length - 1;
export const ELEVATION_BIN_COUNT = ELEVATION_BIN_EDGES.length - 1;

/** DNI derived as hour-mean beam / hour-mean sin(elevation) blows up in the sunrise hour; clamp to physics */
const MAX_DIRECT_NORMAL = 1050;
/** ASHRAE incidence-angle modifier coefficient for glass-covered modules */
const INCIDENCE_ANGLE_B0 = 0.05;
/** Average incidence-angle loss on sky diffuse */
const DIFFUSE_INCIDENCE_FACTOR = 0.95;
const GROUND_ALBEDO = 0.2;
const SNOW_ALBEDO = 0.6;

export type HourSun = {
  /** Compass azimuth at each sub-step midpoint (H+5 min, H+15 min, …) */
  azimuthDegrees: number[];
  /** Apparent elevation (with refraction) at each sub-step midpoint */
  elevationDegrees: number[];
  extraterrestrial: number;
};

export type PoaTerms = {
  /** Beam + circumsolar diffuse on the panel plane — the part the shading mask applies to */
  beam: number[];
  /** Isotropic sky diffuse on the panel plane for an unobstructed sky */
  isotropic: number[];
  /** Ground-reflected irradiance per unit albedo */
  groundPerAlbedo: number[];
};

export type StringCoefficients = { k: number; sky_factor: number; mask: number[][]; ceiling_watts: number };

export function hourSun(hourStartMs: number, latitude: number, longitude: number): HourSun {
  const azimuthDegrees: number[] = [];
  const elevationDegrees: number[] = [];
  let extraterrestrial = 0;
  for (let substep = 0; substep < SUBSTEPS_PER_HOUR; substep++) {
    const position = sunPosition(hourStartMs + SUBSTEP_MS / 2 + substep * SUBSTEP_MS, latitude, longitude);
    azimuthDegrees.push(position.azimuthDegrees);
    elevationDegrees.push(position.apparentElevationDegrees);
    if (substep === 0) extraterrestrial = position.extraterrestrialWattsPerSquareMetre;
  }
  return { azimuthDegrees, elevationDegrees, extraterrestrial };
}

/**
 * Plane-of-array terms (W/m²) for one hour: beam with the ASHRAE incidence-angle modifier,
 * Hay-Davies circumsolar (counted with the beam so the mask shades it too), isotropic sky diffuse
 * and ground reflection.
 */
export function poaTerms(
  sun: HourSun,
  radiation: Pick<RadiationHour, "globalHorizontal" | "diffuseHorizontal" | "directHorizontal">,
  tiltDegrees: number,
  panelAzimuthDegrees: number
): PoaTerms {
  const sinElevations = sun.elevationDegrees.map(elevation => Math.max(Math.sin(degreesToRadians(elevation)), 0));
  const meanSinElevation = sinElevations.reduce((sum, value) => sum + value, 0) / SUBSTEPS_PER_HOUR;
  const weights = sinElevations.map(value => (meanSinElevation > 1e-4 ? value / Math.max(meanSinElevation, 1e-4) : 0));
  const rawDirectNormal = meanSinElevation > 1e-3 ? radiation.directHorizontal / Math.max(meanSinElevation, 1e-3) : 0;
  const directNormal = Math.min(
    Math.min(Math.max(Number.isFinite(rawDirectNormal) ? rawDirectNormal : 0, 0), MAX_DIRECT_NORMAL),
    sun.extraterrestrial
  );
  const anisotropy = Math.min(Math.max(directNormal / sun.extraterrestrial, 0), 1);
  const tiltRadians = degreesToRadians(tiltDegrees);
  const beam: number[] = [];
  const isotropic: number[] = [];
  const groundPerAlbedo: number[] = [];
  for (let substep = 0; substep < SUBSTEPS_PER_HOUR; substep++) {
    const elevation = sun.elevationDegrees[substep];
    const zenithRadians = degreesToRadians(90 - elevation);
    const rawCosIncidence =
      Math.cos(zenithRadians) * Math.cos(tiltRadians) +
      Math.sin(zenithRadians) *
        Math.sin(tiltRadians) *
        Math.cos(degreesToRadians(sun.azimuthDegrees[substep] - panelAzimuthDegrees));
    const cosIncidence = elevation > 0 ? Math.max(rawCosIncidence, 0) : 0;
    const incidenceModifier =
      cosIncidence > 0.05
        ? Math.min(Math.max(1 - INCIDENCE_ANGLE_B0 * (1 / Math.max(cosIncidence, 0.05) - 1), 0), 1)
        : 0;
    const circumsolar =
      meanSinElevation > 1e-3
        ? (radiation.diffuseHorizontal * anisotropy * cosIncidence) / Math.max(meanSinElevation, 1e-3)
        : 0;
    beam.push(directNormal * cosIncidence * incidenceModifier + circumsolar * incidenceModifier);
    isotropic.push(
      ((radiation.diffuseHorizontal * weights[substep] * (1 - anisotropy) * (1 + Math.cos(tiltRadians))) / 2) *
        DIFFUSE_INCIDENCE_FACTOR
    );
    groundPerAlbedo.push((radiation.globalHorizontal * weights[substep] * (1 - Math.cos(tiltRadians))) / 2);
  }
  return { beam, isotropic, groundPerAlbedo };
}

/** Mask bin of a sun position; positions outside the grid fall into the nearest edge bin. */
export function maskBin(
  azimuthDegrees: number,
  elevationDegrees: number
): { azimuthBin: number; elevationBin: number } {
  return {
    azimuthBin: binIndex(AZIMUTH_BIN_EDGES, azimuthDegrees),
    elevationBin: binIndex(ELEVATION_BIN_EDGES, elevationDegrees),
  };
}

export function maskTransmission(mask: number[][], azimuthDegrees: number, elevationDegrees: number): number {
  const { azimuthBin, elevationBin } = maskBin(azimuthDegrees, elevationDegrees);
  return mask[azimuthBin][elevationBin];
}

/** All-ones mask: the starting point of every fit */
export function unshadedMask(): number[][] {
  return Array.from({ length: AZIMUTH_BIN_COUNT }, () => Array<number>(ELEVATION_BIN_COUNT).fill(1));
}

/**
 * Stand-in for a string that has never been fitted (fresh install, or the geometry was edited):
 * a generic horizon — nothing below 6°, full sun from 15° — instead of an unshaded sky, which would
 * promise winter and low-sun production that trees and terrain almost always take away.
 */
export function defaultHorizonMask(): number[][] {
  return Array.from({ length: AZIMUTH_BIN_COUNT }, () =>
    Array.from({ length: ELEVATION_BIN_COUNT }, (_, elevationBin) => {
      const binStart = ELEVATION_BIN_EDGES[elevationBin];
      return binStart < 6 ? 0 : binStart < 15 ? 0.5 : 1;
    })
  );
}

/** Same as numpy's digitize(value, edges) − 1, clipped to a valid bin. */
function binIndex(edges: readonly number[], value: number): number {
  let edgesAtOrBelow = 0;
  while (edgesAtOrBelow < edges.length && edges[edgesAtOrBelow] <= value) edgesAtOrBelow++;
  return Math.min(Math.max(edgesAtOrBelow - 1, 0), edges.length - 2);
}

function degreesToRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}
