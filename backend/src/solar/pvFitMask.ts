import { AZIMUTH_BIN_COUNT, ELEVATION_BIN_COUNT, maskBin } from "./pvModel.ts";

/**
 * Beam transmission per sun-position bin from 10-min production on clear-ish hours: each usable
 * 10-min bin gives (P − k·diffuse − k·ground) / (k·beam), and a bin's value is the beam-weighted
 * 0.6-quantile of those — above the median because residual cloud in "clear" hours only ever
 * pulls transmission down. The same sun positions recur every year, so all history counts.
 */
export function fitBeamMask(samples: MaskSample[]): { mask: number[][]; sampleCounts: number[][] } {
  const valuesByBin = new Map<number, { transmission: number; weight: number }[]>();
  for (const sample of samples) {
    const { azimuthBin, elevationBin } = maskBin(sample.azimuthDegrees, sample.elevationDegrees);
    const flatBin = azimuthBin * ELEVATION_BIN_COUNT + elevationBin;
    const binSamples = valuesByBin.get(flatBin) ?? [];
    binSamples.push({ transmission: sample.transmission, weight: sample.weight });
    valuesByBin.set(flatBin, binSamples);
  }
  const fitted: number[][] = Array.from({ length: AZIMUTH_BIN_COUNT }, () =>
    Array<number>(ELEVATION_BIN_COUNT).fill(Number.NaN)
  );
  const sampleCounts: number[][] = Array.from({ length: AZIMUTH_BIN_COUNT }, () =>
    Array<number>(ELEVATION_BIN_COUNT).fill(0)
  );
  for (const [flatBin, binSamples] of valuesByBin) {
    const azimuthBin = Math.floor(flatBin / ELEVATION_BIN_COUNT);
    const elevationBin = flatBin % ELEVATION_BIN_COUNT;
    sampleCounts[azimuthBin][elevationBin] = binSamples.length;
    if (binSamples.length < MIN_SAMPLES_PER_BIN) continue;
    fitted[azimuthBin][elevationBin] = Math.min(Math.max(weightedQuantile(binSamples, 0.6), 0), 1);
  }
  return { mask: fillUnpopulatedBins(fitted), sampleCounts };
}

export type MaskSample = { azimuthDegrees: number; elevationDegrees: number; transmission: number; weight: number };

const MIN_SAMPLES_PER_BIN = 6;

/**
 * Conservative fill for bins with too few samples: the lowest transmission among populated
 * neighbours (needs two), else the nearest populated bin below it at the same azimuth, else 0.
 * Bins the sun never passes through don't matter; the ones it rarely passes through stay pessimistic.
 */
export function fillUnpopulatedBins(fitted: number[][]): number[][] {
  return fitted.map((row, azimuthBin) =>
    row.map((value, elevationBin) => {
      if (Number.isFinite(value)) return value;
      const neighbours: number[] = [];
      for (let neighbourAzimuth = azimuthBin - 1; neighbourAzimuth <= azimuthBin + 1; neighbourAzimuth++) {
        for (let neighbourElevation = elevationBin - 1; neighbourElevation <= elevationBin + 1; neighbourElevation++) {
          const neighbour = fitted[neighbourAzimuth]?.[neighbourElevation];
          if (neighbour !== undefined && Number.isFinite(neighbour)) neighbours.push(neighbour);
        }
      }
      if (neighbours.length >= 2) return Math.min(...neighbours);
      const lowerPopulated = row.slice(0, elevationBin).filter(Number.isFinite);
      return lowerPopulated.length ? lowerPopulated[lowerPopulated.length - 1] : 0;
    })
  );
}

/** First value whose cumulative weight reaches `quantile` of the total (numpy searchsorted, side="left"). */
function weightedQuantile(samples: { transmission: number; weight: number }[], quantile: number): number {
  const sorted = [...samples].sort((left, right) => left.transmission - right.transmission);
  const totalWeight = sorted.reduce((sum, sample) => sum + sample.weight, 0);
  let cumulative = 0;
  for (const sample of sorted) {
    cumulative += sample.weight;
    if (cumulative >= quantile * totalWeight) return sample.transmission;
  }
  return sorted[sorted.length - 1].transmission;
}
