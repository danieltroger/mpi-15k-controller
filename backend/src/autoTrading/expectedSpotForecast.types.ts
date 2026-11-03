/**
 * What terminal_value_mode "forecast" based a plan's expected spot on (expectedSpotForecast.ts). It rides on
 * the ExpectedSpotEstimate into the plan's status (last_plan.expected_spot), which the trading panel shows.
 * Pure types with no runtime imports, so the frontend imports them directly (see CLAUDE.md on shared ws types).
 */

/** One predicted day the expected spot averages */
export type ForecastSpotDay = {
  /** YYYY-MM-DD, Europe/Stockholm */
  date: string;
  /** 2, 3 or 4: days after the issue day */
  leadDays: number;
  /** Predicted mean of the day's spot slots, SEK/kWh excl. VAT */
  predictedMeanSpot: number;
};

export type ForecastSpotSummary =
  | {
      used: true;
      /** YYYY-MM-DD: the day whose day-ahead auction published D+1 */
      issueDate: string;
      /** D+2…D+4, the days the expected spot is the mean of */
      days: ForecastSpotDay[];
      /** Their mean, SEK/kWh, before the deviation limit */
      predictedMeanSpot: number;
      /** The trailing expected spot the value is held near (terminal_value_forecast_max_deviation_sek) */
      trailingSpot: number;
      /** Whether the deviation limit moved the value to its edge */
      limited: boolean;
      /** ISO instant the weather forecast behind it was fetched */
      weatherFetchedAt: string;
    }
  | {
      used: false;
      /** Why the outlook couldn't be used; the trailing mean stood in */
      fallbackReason: string;
    };
