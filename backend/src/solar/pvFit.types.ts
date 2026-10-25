import type { SolarStringKey } from "./solarModel.types.ts";

/**
 * Columnar fit input (typed arrays, so it crosses into the fit worker by structured clone without
 * per-hour objects). Hour i covers [hourStartMs[i], +1 h); sub-step arrays hold SUBSTEPS_PER_HOUR
 * values per hour, hour-major.
 */
export type SolarFitDataset = {
  hourStartMs: Float64Array;
  sunAzimuthDegrees: Float64Array;
  sunElevationDegrees: Float64Array;
  extraterrestrial: Float64Array;
  /** Irradiance the mask and physical capacity are fitted on (satellite, or the forecast archive as fallback) */
  physical: RadiationColumns;
  /** The forecast archive (same model family as the live forecast), for the forecast calibration */
  forecast: RadiationColumns;
  /** Snow on the ground (forecast snow depth > 2 cm): raises the ground albedo */
  snowOnGround: Uint8Array;
  strings: Record<SolarStringKey, StringObservations>;
};

export type RadiationColumns = {
  globalHorizontal: Float64Array;
  diffuseHorizontal: Float64Array;
  directHorizontal: Float64Array;
};

export type StringObservations = {
  /** Mean power of the hour (NaN where the string didn't exist or data is missing) */
  hourlyWatts: Float64Array;
  /** Mean power of each 10-min bin, hour-major */
  substepWatts: Float64Array;
  /**
   * 1 where the hour may be fitted on: complete data, daylight, string wired, irradiance present,
   * and not stalled (inverter outage), snow-gated or curtailed (full battery, export not taking it)
   */
  usable: Uint8Array;
};

export type StringGeometry = { tilt_degrees: number; azimuth_degrees: number; ceiling_watts: number };

export type StringFitResult = {
  physical_k: number;
  physical_sky_factor: number;
  forecast_k: number;
  forecast_sky_factor: number;
  mask: number[][];
  mask_sample_counts: number[][];
  fit_hours: number;
};
