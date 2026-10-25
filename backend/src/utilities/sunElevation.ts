import { sunPosition } from "./sunPosition.ts";

/**
 * Geometric sun elevation above the horizon in degrees (negative = below), see sunPosition.ts for
 * the formulation and its accuracy. No atmospheric refraction: it lifts the apparent sun by up to
 * ~0.6° right at the horizon, which the daylight gates consuming this deliberately ignore.
 */
export function sunElevationDegrees(atMs: number, latitudeDegrees: number, longitudeDegrees: number): number {
  return sunPosition(atMs, latitudeDegrees, longitudeDegrees).geometricElevationDegrees;
}
