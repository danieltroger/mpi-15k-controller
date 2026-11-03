/**
 * The "forecast" expected spot from the pieces expectedSpotForecast.ts gathered: the outlook's predicted mean
 * of D+2…D+4 held within terminal_value_forecast_max_deviation_sek of the trailing estimate, or that trailing
 * estimate standing in, with the reason. Pure (type-only imports): the backtest harness replays it.
 *
 * The detail strings are written to read inside the planner's terminal-value note, which appends the value:
 * "End-of-plan energy valued at 2.95 SEK/kWh (price outlook mean spot D+2..4 (11-05 1.48, 11-06 1.55,
 * 11-07 1.90) 1.64, k 0.9)".
 */
import type { PriceOutlook } from "./priceOutlook.types.ts";
import type { ExpectedSpotEstimate } from "./planner.types.ts";

/** The trailing estimate with a value: the anchor the outlook is held near */
export type TrailingSpotAnchor = ExpectedSpotEstimate & { expectedSpot: number };

/** Main: the expected spot from an available outlook */
export function forecastSpotEstimate(input: {
  outlook: PriceOutlook;
  trailing: TrailingSpotAnchor;
  maxDeviationSek: number;
  weatherFetchedAtMs: number;
}): ExpectedSpotEstimate {
  const { outlook, trailing, maxDeviationSek } = input;
  const days = outlook.days
    .filter(day => day.leadDays <= 4)
    .map(day => ({ date: day.date, leadDays: day.leadDays, predictedMeanSpot: day.predictedMeanSpot }));
  const predictedMeanSpot = outlook.meanD2toD4;
  const expectedSpot = heldNear(predictedMeanSpot, trailing.expectedSpot, maxDeviationSek);
  const limited = expectedSpot !== predictedMeanSpot;
  const dayList = days.map(day => `${day.date.slice(5)} ${day.predictedMeanSpot.toFixed(2)}`).join(", ");
  return {
    expectedSpot,
    source: "forecast",
    detail: limited
      ? `price outlook mean spot D+2..4 ${predictedMeanSpot.toFixed(2)} (${dayList}), held within ${maxDeviationSek.toFixed(2)} of the ${trailing.detail} ${trailing.expectedSpot.toFixed(2)} at`
      : `price outlook mean spot D+2..4 (${dayList})`,
    forecast: {
      used: true,
      issueDate: outlook.issueDate,
      days,
      predictedMeanSpot,
      trailingSpot: trailing.expectedSpot,
      limited,
      weatherFetchedAt: new Date(input.weatherFetchedAtMs).toISOString(),
    },
  };
}

/** The trailing estimate standing in for an outlook that couldn't be had, saying why */
export function fallbackSpotEstimate(trailing: ExpectedSpotEstimate, reason: string): ExpectedSpotEstimate {
  return {
    expectedSpot: trailing.expectedSpot,
    source: trailing.source,
    detail:
      trailing.expectedSpot === undefined
        ? `the price outlook is unavailable (${reason}), and ${trailing.detail}`
        : `price outlook unavailable (${reason}), so the ${trailing.detail}`,
    forecast: { used: false, fallbackReason: reason },
  };
}

/**
 * The predicted value within maxDeviationSek of the anchor. Absolute rather than relative: the terminal value
 * is affine in p̂ with the surcharges dominating, so a SEK of p̂ moves it the same at any price level, and a
 * ratio band would collapse onto a near-zero trailing mean (a windy week) exactly when the outlook sees the
 * price rising.
 */
export function heldNear(predicted: number, anchor: number, maxDeviationSek: number): number {
  return Math.min(anchor + maxDeviationSek, Math.max(anchor - maxDeviationSek, predicted));
}
