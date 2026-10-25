/**
 * Recency weights that keep each calendar month's share of the total: recency decides which YEAR
 * dominates within a calendar month, never the season mix. Plain decay would let a refit in
 * December over-weight winter hours and alias the season into the capacity.
 */
export function seasonallyBalancedDecayWeights(
  hourStartMs: Float64Array,
  selectedHours: Uint8Array,
  nowMs: number,
  halfLifeDays: number
): Float64Array {
  const decay = new Float64Array(hourStartMs.length);
  const decaySumByMonth = new Float64Array(12);
  const countByMonth = new Float64Array(12);
  for (let hour = 0; hour < hourStartMs.length; hour++) {
    if (!selectedHours[hour]) continue;
    decay[hour] = recencyWeight(hourStartMs[hour], nowMs, halfLifeDays);
    const month = new Date(hourStartMs[hour]).getUTCMonth();
    decaySumByMonth[month] += decay[hour];
    countByMonth[month] += 1;
  }
  const balanced = new Float64Array(hourStartMs.length);
  for (let hour = 0; hour < hourStartMs.length; hour++) {
    if (!selectedHours[hour]) continue;
    const month = new Date(hourStartMs[hour]).getUTCMonth();
    balanced[hour] = (decay[hour] * countByMonth[month]) / decaySumByMonth[month];
  }
  return balanced;
}

/** 1 for an observation from `nowMs`, ½ at one half-life of age */
export function recencyWeight(observedAtMs: number, nowMs: number, halfLifeDays: number): number {
  return Math.pow(0.5, (nowMs - observedAtMs) / 86_400_000 / halfLifeDays);
}
