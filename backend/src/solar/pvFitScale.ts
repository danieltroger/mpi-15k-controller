/**
 * Non-negative least squares for target ≈ c0·first + c1·second, optionally reweighted (Huber IRLS)
 * for robustness. iterations = 1 is plain weighted NNLS — the right choice for the forecast
 * calibration, which must estimate the MEAN (forecast errors are skewed; a robust fit lands on the
 * median and under-forecasts sunny surprises). The physics fit on satellite data uses 8 iterations.
 */
export function fitNonNegativePair(
  first: Float64Array,
  second: Float64Array,
  target: Float64Array,
  options: { iterations: number; baseWeights?: Float64Array }
): { coefficients: [number, number]; residuals: Float64Array } {
  const sampleCount = target.length;
  const baseWeights = options.baseWeights ?? new Float64Array(sampleCount).fill(1);
  let weights: Float64Array = Float64Array.from(baseWeights);
  let coefficients: [number, number] = [0, 0];
  const residuals = new Float64Array(sampleCount);
  for (let iteration = 0; iteration < options.iterations; iteration++) {
    coefficients = solveWeightedNonNegativePair(first, second, target, weights);
    for (let sample = 0; sample < sampleCount; sample++) {
      residuals[sample] = target[sample] - coefficients[0] * first[sample] - coefficients[1] * second[sample];
    }
    weights = huberWeights(residuals, baseWeights);
  }
  return { coefficients, residuals };
}

/** Exact 2-variable NNLS: the unconstrained optimum if feasible, else the best boundary solution. */
function solveWeightedNonNegativePair(
  first: Float64Array,
  second: Float64Array,
  target: Float64Array,
  weights: Float64Array
): [number, number] {
  let firstFirst = 0;
  let secondSecond = 0;
  let firstSecond = 0;
  let firstTarget = 0;
  let secondTarget = 0;
  for (let sample = 0; sample < target.length; sample++) {
    const weight = weights[sample];
    firstFirst += weight * first[sample] * first[sample];
    secondSecond += weight * second[sample] * second[sample];
    firstSecond += weight * first[sample] * second[sample];
    firstTarget += weight * first[sample] * target[sample];
    secondTarget += weight * second[sample] * target[sample];
  }
  const determinant = firstFirst * secondSecond - firstSecond * firstSecond;
  if (Math.abs(determinant) > 1e-12 * Math.max(1, firstFirst * secondSecond)) {
    const firstCoefficient = (firstTarget * secondSecond - secondTarget * firstSecond) / determinant;
    const secondCoefficient = (firstFirst * secondTarget - firstSecond * firstTarget) / determinant;
    if (firstCoefficient >= 0 && secondCoefficient >= 0) return [firstCoefficient, secondCoefficient];
  }
  // Objective relative to the constant Σw·target², which doesn't change the arg-min
  const objective = ([firstCoefficient, secondCoefficient]: [number, number]) =>
    -2 * firstCoefficient * firstTarget -
    2 * secondCoefficient * secondTarget +
    firstCoefficient * firstCoefficient * firstFirst +
    2 * firstCoefficient * secondCoefficient * firstSecond +
    secondCoefficient * secondCoefficient * secondSecond;
  const candidates: [number, number][] = [
    [firstFirst > 0 ? Math.max(0, firstTarget / firstFirst) : 0, 0],
    [0, secondSecond > 0 ? Math.max(0, secondTarget / secondSecond) : 0],
    [0, 0],
  ];
  return candidates.reduce((best, candidate) => (objective(candidate) < objective(best) ? candidate : best));
}

/** Huber weights at 1.5 × MAD-based scale, multiplied onto the base (recency) weights. */
function huberWeights(residuals: Float64Array, baseWeights: Float64Array): Float64Array {
  const scale = 1.4826 * median(residuals.map(Math.abs)) + 1e-6;
  const weights = new Float64Array(residuals.length);
  for (let sample = 0; sample < residuals.length; sample++) {
    const scaled = Math.abs(residuals[sample]) / (1.5 * scale);
    weights[sample] = baseWeights[sample] * (scaled <= 1 ? 1 : 1 / Math.max(scaled, 1e-9));
  }
  return weights;
}

/** numpy-compatible median (mean of the two middle values for even counts). */
export function median(values: Float64Array): number {
  if (!values.length) return 0;
  const sorted = Float64Array.from(values).sort();
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
