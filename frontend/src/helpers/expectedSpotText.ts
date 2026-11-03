import type { ExpectedSpotEstimate } from "../../../backend/src/autoTrading/planner.types";

/**
 * The trading panel's line about the spot price a plan expects after its horizon: the value, and whether it
 * came from the price outlook (its D+2…D+4 days), the trailing mean, or the trailing mean standing in for an
 * outlook that couldn't be had (and why).
 */
export function expectedSpotText(estimate: ExpectedSpotEstimate): string {
  const value = estimate.expectedSpot === undefined ? "none" : `${estimate.expectedSpot.toFixed(2)} SEK/kWh spot`;
  const forecast = estimate.forecast;
  if (!forecast?.used) return `Expected price after the horizon: ${value} — ${estimate.detail}.`;
  const days = forecast.days.map(day => `${day.date.slice(5)} ${day.predictedMeanSpot.toFixed(2)}`).join(", ");
  const limit = forecast.limited
    ? ` The outlook's ${forecast.predictedMeanSpot.toFixed(2)} is held at the limit from the trailing mean ${forecast.trailingSpot.toFixed(2)}.`
    : ` Trailing mean: ${forecast.trailingSpot.toFixed(2)}.`;
  return `Expected price after the horizon: ${value} from the price outlook issued ${forecast.issueDate.slice(5)} (D+2..4: ${days}).${limit}`;
}
