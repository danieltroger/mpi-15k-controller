/**
 * Per-string snow correction. Snow comes off the two roofs very differently (string 1 is never
 * cleared, string 2 is sometimes scraped by hand), so each string learns from its OWN recent
 * production: a causal energy-weighted ratio actual/model over informative daylight hours
 * (half-life of 8 such hours), applied only while the forecast snow gate is open, only ever
 * downwards, and relaxing back to 1 with forecast lead time (snow outlasts a day or two; τ = 72 h).
 * Backtest: winter 2025/26 day-ahead daily MAE 3.1 → 1.4 kWh, no effect outside snow periods.
 */
export function snowNowcastFactor(input: { ratio: number; gateOpen: boolean; leadHours: number }): number {
  if (!input.gateOpen) return 1;
  const clamped = Math.min(Math.max(input.ratio, RATIO_FLOOR), 1);
  return 1 - (1 - clamped) * Math.exp(-Math.max(input.leadHours, 0) / RELAX_HOURS);
}

/** The tracker's ratio after the given hours (oldest first). Missing actuals are skipped. */
export function nowcastRatio(hours: { actualWatts: number; modelWatts: number }[]): number {
  const decay = Math.pow(0.5, 1 / HALF_LIFE_INFORMATIVE_HOURS);
  let actualSum = 0;
  let modelSum = 0;
  for (const { actualWatts, modelWatts } of hours) {
    if (!Number.isFinite(actualWatts) || !Number.isFinite(modelWatts) || modelWatts <= MIN_INFORMATIVE_MODEL_WATTS) {
      continue;
    }
    actualSum = actualSum * decay + actualWatts;
    modelSum = modelSum * decay + modelWatts;
  }
  return modelSum > MIN_TRACKED_MODEL_WATTS ? actualSum / modelSum : 1;
}

const HALF_LIFE_INFORMATIVE_HOURS = 8;
/** Hours the model expects less than this from a string carry no snow evidence */
const MIN_INFORMATIVE_MODEL_WATTS = 150;
/** Below this much decayed expected power the ratio is too noisy to act on */
const MIN_TRACKED_MODEL_WATTS = 300;
const RATIO_FLOOR = 0.03;
const RELAX_HOURS = 72;
