/**
 * Shapes of the SE3 daily-mean spot outlook (priceOutlook.ts). Pure types with no runtime imports, so
 * a later dashboard view can import PriceOutlook directly and the two sides can't drift — see
 * CLAUDE.md on shared ws types.
 */

/** Days after the issue day the model predicts; D+1 is the published day-ahead auction it starts from */
export type OutlookLeadDays = 2 | 3 | 4 | 5 | 6;

/** Wind sites whose power-curve output feeds the model, named as in the winter study */
export type OutlookWindPointName =
  | "SE1_markbygden"
  | "SE2_central"
  | "SE3_halland"
  | "SE4_skane"
  | "DK1_west"
  | "DE_north"
  | "DE_northsea_off"
  | "Baltic_off";

export type OutlookTemperaturePointName = "Stockholm" | "Goteborg" | "Orebro";

/** One forecast value at its instant: open-meteo's wind speed and temperature are instantaneous, not hour averages */
export type HourlyWeatherSample = { atMs: number; value: number };

/** The open-meteo forecast the outlook reads, hours without a value already dropped */
export type OutlookWeather = {
  fetchedAtMs: number;
  /** wind_speed_100m, m/s */
  windSpeedByPoint: Record<OutlookWindPointName, HourlyWeatherSample[]>;
  /** temperature_2m, °C */
  temperatureByPoint: Record<OutlookTemperaturePointName, HourlyWeatherSample[]>;
};

/** One Europe/Stockholm day's model inputs */
export type OutlookDayWeather = {
  /** Capacity-weighted mean power-curve output of the Nordic wind sites, 0…1 */
  nordicWindCapacityFactor: number;
  /** Same for the German/Baltic sites */
  continentalWindCapacityFactor: number;
  /** Mean of Stockholm, Göteborg and Örebro */
  temperatureC: number;
  /** Weekend or one of the study's holidays (priceOutlookCalendar.ts) */
  nonWorkingDay: boolean;
};

export type OutlookDay = OutlookDayWeather & {
  /** YYYY-MM-DD, Europe/Stockholm */
  date: string;
  leadDays: OutlookLeadDays;
  /** Predicted mean of the day's spot slots, SEK/kWh excl. VAT (elprisetjustnu's SEK_per_kWh) */
  predictedMeanSpot: number;
};

export type PriceOutlook = {
  /** YYYY-MM-DD, Europe/Stockholm: the day whose auction has published D+1 */
  issueDate: string;
  /** Known mean spot of D+1, SEK/kWh */
  dayAheadMeanSpot: number;
  /** Mean of the 30 daily means D−28…D+1, SEK/kWh */
  trailing30DayMeanSpot: number;
  /** D+1's weather: every target day's prediction is a change from this baseline */
  dayAheadWeather: OutlookDayWeather;
  /** D+2…D+6 in order */
  days: OutlookDay[];
  /** Mean predicted daily mean over D+2…D+4: the value of energy left at the end of the planner's horizon */
  meanD2toD4: number;
  /** Highest predicted daily mean over D+2…D+5: the "expensive spell ahead" score */
  maxD2toD5: number;
};

export type PriceOutlookResult = { available: true; outlook: PriceOutlook } | { available: false; reason: string };
