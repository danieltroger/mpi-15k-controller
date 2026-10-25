/**
 * Pure type declarations for the physical PV model and its machine-owned state file
 * (backend/solar_model_state.json). No runtime imports, so the frontend could import them too —
 * see CLAUDE.md on shared wire types.
 */

/** string1 = MPPT1 (roof 1, south), string2 = MPPT2 (roof 2, west-north-west) */
export type SolarStringKey = "string1" | "string2";

/**
 * One hour of open-meteo irradiance (W/m², hour means), keyed by the START of the hour it averages.
 * open-meteo labels each value with the END of its averaging hour; the parser shifts it back.
 */
export type RadiationHour = {
  hourStartMs: number;
  /** shortwave_radiation, GHI */
  globalHorizontal: number;
  /** diffuse_radiation, DHI */
  diffuseHorizontal: number;
  /** direct_radiation: the beam on a horizontal surface, not DNI */
  directHorizontal: number;
  /** Snowfall during the hour, cm (absent from sources without it) */
  snowfallCm?: number;
  /** Snow depth on the ground, m */
  snowDepthMetres?: number;
};

/** What the monthly refit learns per string. snake_case: it is persisted verbatim. */
export type SolarStringFit = {
  /** W per W/m² of plane-of-array irradiance, fitted on the mask's (physical) irradiance source */
  physical_k: number;
  /** Isotropic sky diffuse seen by the panels relative to an unobstructed sky (horizon trees < 1) */
  physical_sky_factor: number;
  /**
   * The same two, re-calibrated by least squares against the forecast archive: forecast irradiance
   * has its own seasonal bias (darker than satellite in summer) and the forecast must hit the MEAN,
   * so these are what the live forecast uses. A sky factor above 1 here is forecast calibration,
   * not physics: "forecast says diffuse" means some sun on average.
   */
  forecast_k: number;
  forecast_sky_factor: number;
  /** Beam transmission [azimuth bin][elevation bin], bins in pvModel.ts — 1 = unshaded */
  mask: number[][];
  /** 10-min samples behind each mask bin (bins under 6 samples were filled conservatively) */
  mask_sample_counts: number[][];
  /** Deadbanded slow-trend multiplier on forecast_k (degradation, soiling, a removed tree), normally 1 */
  level_multiplier: number;
  /** 90-day actual/model ratio at recent refits, oldest first (null = window not informative) */
  level_ratios: { at: string; ratio: number | null }[];
};

export type SolarModelState = {
  version: 1;
  fitted_at: string;
  mask_irradiance_source: "satellite" | "forecast_archive";
  /** Geometry the mask was fitted for — a config edit invalidates the fit until the next refit */
  geometry: Record<SolarStringKey, { tilt_degrees: number; azimuth_degrees: number }>;
  strings: Record<SolarStringKey, SolarStringFit>;
  /** Daylight hours each string's fit used */
  fit_hours: Record<SolarStringKey, number>;
  /** Trailing-year daily-kWh MAE of the accepted fit on forecast inputs (the regression gate's yardstick) */
  trailing_year_daily_mae_kwh: number | null;
  /** Refits rejected in a row by the trailing-year gate — the second one pages */
  consecutive_rejections: number;
  last_attempt?: { at: string; outcome: "accepted" | "rejected" | "failed"; reason?: string };
};
