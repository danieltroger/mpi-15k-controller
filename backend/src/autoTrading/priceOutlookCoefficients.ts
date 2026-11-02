import type { OutlookLeadDays, OutlookTemperaturePointName, OutlookWindPointName } from "./priceOutlook.types.ts";

/**
 * The SE3 daily-mean spot outlook model from the 2026-11 winter study (scripts/trigger.py →
 * model_coefficients.json): one OLS fit per lead D+k of
 *   log(spot(D+k) + 0.3) − log(spot(D+1) + 0.3)
 * on the D+1 → D+k change in Nordic and continental wind output, 3-city temperature and the
 * non-working-day flag, plus a pull of log(trailing 30-day mean + 0.3) − log(spot(D+1) + 0.3).
 *
 * Training window: 486 issue days, October–March only (Dec 2022–Mar 2023, Oct 2023–Mar 2024,
 * Oct 2024–Mar 2025), against analysis weather (no forecast error) and elprisetjustnu SE3 daily
 * means. Out of sample (Oct 2025–Mar 2026 + Oct 2026, 210 issue days, real forecasts), for the mean
 * of D+2…D+4: MAE 0.17 vs 0.32 SEK/kWh for persistence, Spearman 0.81 vs 0.50, AUC for > 1 SEK 0.90
 * vs 0.76. Summer was never fitted or validated.
 *
 * SE3-specific: the intercepts, the log offset and the reversion strength encode SE3's price level
 * and dynamics. Another area needs its own fit, hence isOutlookAvailableForArea. Changing a site, a
 * weight or the power curve below invalidates these numbers, so refit the study instead.
 */
export const SE3_OUTLOOK_COEFFICIENTS: Record<OutlookLeadDays, OutlookLeadCoefficients> = {
  2: {
    intercept: -0.01259554106994481,
    nordicWindChange: -1.3029071582503595,
    continentalWindChange: 0.005077978588927303,
    temperatureChange: -0.03708274007393313,
    nonWorkingChange: -0.25018937995572454,
    trailing30DayPull: 0.11081591144524838,
  },
  3: {
    intercept: -0.020049834591763977,
    nordicWindChange: -1.3291138002013383,
    continentalWindChange: 0.013581352305737595,
    temperatureChange: -0.040736493352008574,
    nonWorkingChange: -0.2474066261486899,
    trailing30DayPull: 0.18483144695261214,
  },
  4: {
    intercept: -0.022808666528065298,
    nordicWindChange: -1.3373416862625302,
    continentalWindChange: 0.007994431436752384,
    temperatureChange: -0.04001639722590516,
    nonWorkingChange: -0.2543707204653205,
    trailing30DayPull: 0.19678407355531985,
  },
  5: {
    intercept: -0.021832894926292146,
    nordicWindChange: -1.3843357830451375,
    continentalWindChange: -0.0015806280190616424,
    temperatureChange: -0.040759740851718414,
    nonWorkingChange: -0.2560931685968617,
    trailing30DayPull: 0.15955130282786437,
  },
  6: {
    intercept: -0.01881899295425219,
    nordicWindChange: -1.4111186411765742,
    continentalWindChange: -0.013122855824188248,
    temperatureChange: -0.043319223794817695,
    nonWorkingChange: -0.24637759002982262,
    trailing30DayPull: 0.11110670545011589,
  },
};

/** Whether the outlook's coefficients apply to this price area; callers fall back to another price source otherwise */
export function isOutlookAvailableForArea(area: string): boolean {
  return area === "SE3";
}

/** Each term multiplies its D+1 → D+k change and adds to log(spot(D+k) + offset) − log(spot(D+1) + offset) */
export type OutlookLeadCoefficients = {
  intercept: number;
  /** Per unit (0…1) change of the Nordic capacity factor */
  nordicWindChange: number;
  /** Per unit (0…1) change of the continental capacity factor */
  continentalWindChange: number;
  /** Per °C change of the 3-city mean temperature */
  temperatureChange: number;
  /** Per change of the non-working flag (+1: D+k off while D+1 is a working day) */
  nonWorkingChange: number;
  /** Times log(trailing 30-day mean + offset) − log(spot(D+1) + offset) */
  trailing30DayPull: number;
};

/** log(price + 0.3): keeps near-zero and negative SE3 days finite while making swings proportional to the level */
export const OUTLOOK_LOG_PRICE_OFFSET = 0.3;
/** Prices below −0.28 SEK/kWh count as −0.28, so the log never sees zero or less */
export const OUTLOOK_LOG_PRICE_FLOOR = -OUTLOOK_LOG_PRICE_OFFSET + 0.02;

/** Generic turbine power curve at 100 m: cubic from cut-in to rated speed, flat to cut-out, m/s */
export const TURBINE_CUT_IN_MS = 3;
export const TURBINE_RATED_MS = 12;
export const TURBINE_CUT_OUT_MS = 25;

export type OutlookWindPoint = {
  latitude: number;
  longitude: number;
  /** Which capacity-weighted mean the site feeds */
  region: "nordic" | "continental";
  /** Rough installed wind capacity the site stands for, GW: its weight in that mean */
  installedGigawatts: number;
};

/** The order is the open-meteo request's point order (wind sites, then cities) */
export const OUTLOOK_WIND_POINTS: Record<OutlookWindPointName, OutlookWindPoint> = {
  DK1_west: { latitude: 56.0, longitude: 8.5, region: "nordic", installedGigawatts: 6.0 },
  DE_north: { latitude: 54.0, longitude: 9.0, region: "continental", installedGigawatts: 30.0 },
  DE_northsea_off: { latitude: 54.4, longitude: 6.5, region: "continental", installedGigawatts: 9.0 },
  Baltic_off: { latitude: 55.0, longitude: 14.0, region: "continental", installedGigawatts: 3.0 },
  SE4_skane: { latitude: 55.6, longitude: 13.2, region: "nordic", installedGigawatts: 1.8 },
  SE3_halland: { latitude: 57.0, longitude: 12.3, region: "nordic", installedGigawatts: 3.5 },
  SE2_central: { latitude: 63.0, longitude: 16.5, region: "nordic", installedGigawatts: 8.0 },
  SE1_markbygden: { latitude: 65.6, longitude: 20.6, region: "nordic", installedGigawatts: 4.0 },
};

export const OUTLOOK_TEMPERATURE_POINTS: Record<OutlookTemperaturePointName, { latitude: number; longitude: number }> =
  {
    Stockholm: { latitude: 59.33, longitude: 18.07 },
    Goteborg: { latitude: 57.71, longitude: 11.97 },
    Orebro: { latitude: 59.27, longitude: 15.21 },
  };
