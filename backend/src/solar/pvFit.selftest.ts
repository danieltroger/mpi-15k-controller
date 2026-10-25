/**
 * Self-test for the refit: a synthetic plant with known capacity, sky factor and shading mask must
 * be recovered by the fit, and the gates must page only on real failures. Run from backend/ with:
 *   yarn node src/solar/pvFit.selftest.ts
 */
import { fitSolarString } from "./pvFit.ts";
import { maskBinColumn, prepareStringTerms } from "./pvFitColumns.ts";
import { hourSun, maskBin, poaTerms, stringSubstepWatts, unshadedMask, SUBSTEPS_PER_HOUR } from "./pvModel.ts";
import { judgeSolarRefit, type RefitJudgement } from "./solarRefitGates.ts";
import type { SolarFitDataset } from "./pvFit.types.ts";
import type { SolarRefitOutput } from "./solarRefitComputation.ts";
import type { SolarModelFit } from "./solarModel.types.ts";
import type { SolarStringSpec } from "../config/config.types.ts";

const fails: string[] = [];
function check(name: string, condition: boolean, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}: ${name} ${detail}`);
  if (!condition) fails.push(name);
}

const LATITUDE = 59.246761;
const LONGITUDE = 15.223236;
const HOUR_MS = 3600_000;

// ---------- synthetic plant: a south string behind a west-south-west tree and a low horizon ----------
{
  const trueMask = unshadedMask().map((row, azimuthBin) =>
    row.map((_, elevationBin) => {
      const { azimuthBin: treeStart } = maskBin(220, 20);
      const { azimuthBin: treeEnd } = maskBin(255, 20);
      if (elevationBin <= 3) return 0.1; // below 12°: horizon trees
      return azimuthBin >= treeStart && azimuthBin <= treeEnd && elevationBin <= 8 ? 0.3 : 1;
    })
  );
  const truth = { k: 9, sky_factor: 0.9, mask: trueMask, ceiling_watts: 1e9 };
  const dataset = syntheticDataset(truth, 420);
  const terms = prepareStringTerms(
    dataset,
    { tilt_degrees: 36, azimuth_degrees: 180, ceiling_watts: 1e9 },
    maskBinColumn(dataset)
  );
  const fit = fitSolarString(dataset, "string1", terms, {
    nowMs: dataset.hourStartMs[dataset.hourStartMs.length - 1],
    mask_half_life_days: 365,
  });
  check(
    "fit: capacity recovered within 3 %",
    Math.abs(fit.physical_k / truth.k - 1) < 0.03,
    `(${fit.physical_k.toFixed(3)} vs ${truth.k})`
  );
  check(
    "fit: forecast capacity equals physical on identical irradiance",
    Math.abs(fit.forecast_k / fit.physical_k - 1) < 0.02,
    `(${fit.forecast_k.toFixed(3)})`
  );
  check(
    "fit: sky factor recovered",
    Math.abs(fit.physical_sky_factor - truth.sky_factor) < 0.1,
    `(${fit.physical_sky_factor.toFixed(3)})`
  );
  const tree = maskBin(235, 25);
  const open = maskBin(180, 40);
  const treeValue = fit.mask[tree.azimuthBin][tree.elevationBin];
  const openValue = fit.mask[open.azimuthBin][open.elevationBin];
  check("fit: tree shading learned", Math.abs(treeValue - 0.3) < 0.1, `(${treeValue.toFixed(3)})`);
  check("fit: open sky stays unshaded", openValue > 0.9, `(${openValue.toFixed(3)})`);
  check(
    "fit: populated bins report their sample counts",
    fit.mask_sample_counts[open.azimuthBin][open.elevationBin] >= 6
  );
}

// ---------- gates: only real failures page ----------
{
  const specs: Record<"string1" | "string2", SolarStringSpec> = {
    string1: {
      tilt_degrees: 36,
      azimuth_degrees: 180,
      nameplate_kwp: 11.25,
      max_current_amps: 23,
      typical_mpp_volts: 460,
    },
    string2: {
      tilt_degrees: 45,
      azimuth_degrees: 300,
      nameplate_kwp: 6.16,
      max_current_amps: 23,
      typical_mpp_volts: 580,
    },
  };
  const healthyCoverage = { recentCompleteShare: 0.97, completeDays: 800 };
  const julyMs = Date.parse("2026-07-03T01:40:00Z");
  const januaryMs = Date.parse("2026-01-03T01:40:00Z");
  const computation = (overrides: {
    k1?: number;
    capacityChange?: number;
    maskChange?: number;
    level1?: number | null;
    candidateMae?: number;
  }) =>
    ({
      strings: {
        string1: {
          fit: fitResult(overrides.k1 ?? 8.9),
          capacity_change: overrides.capacityChange ?? 0.01,
          mask_energy_change: overrides.maskChange ?? 0.005,
          level: { ratio: overrides.level1 === undefined ? 1.01 : overrides.level1, modelled_kwh: 2000 },
        },
        string2: {
          fit: fitResult(5.6),
          capacity_change: 0,
          mask_energy_change: 0,
          level: { ratio: 0.99, modelled_kwh: 700 },
        },
      },
      trailing_year: { days: 200, candidate_mae_kwh: overrides.candidateMae ?? 4.0, incumbent_mae_kwh: 4.0 },
    }) satisfies SolarRefitOutput;
  const incumbent = incumbentState();

  const healthy = judgeSolarRefit({
    computation: computation({}),
    incumbent,
    consecutiveRejections: 0,
    specs,
    coverage: healthyCoverage,
    nowMs: julyMs,
  });
  check(
    "gates: a normal refit is accepted silently",
    healthy.accepted && !pageReasonsOf(healthy).length && !healthy.warnReasons.length
  );

  const brokenLogging = judgeSolarRefit({
    computation: computation({}),
    incumbent,
    consecutiveRejections: 0,
    specs,
    coverage: { recentCompleteShare: 0.4, completeDays: 800 },
    nowMs: julyMs,
  });
  check(
    "gates: broken telemetry pages and rejects",
    !brokenLogging.accepted && pageReasonsOf(brokenLogging).length === 1
  );

  const wrongCapacity = judgeSolarRefit({
    computation: computation({ k1: 3 }),
    incumbent,
    consecutiveRejections: 0,
    specs,
    coverage: healthyCoverage,
    nowMs: julyMs,
  });
  check(
    "gates: implausible capacity pages and rejects",
    !wrongCapacity.accepted && pageReasonsOf(wrongCapacity).some(reason => reason.includes("nameplate"))
  );

  const firstJump = judgeSolarRefit({
    computation: computation({ capacityChange: 0.15 }),
    incumbent,
    consecutiveRejections: 0,
    specs,
    coverage: healthyCoverage,
    nowMs: julyMs,
  });
  check(
    "gates: a first soft rejection only warns",
    !firstJump.accepted &&
      !pageReasonsOf(firstJump).length &&
      firstJump.warnReasons.length === 1 &&
      firstJump.consecutiveRejections === 1
  );
  const secondJump = judgeSolarRefit({
    computation: computation({ capacityChange: 0.15 }),
    incumbent,
    consecutiveRejections: 1,
    specs,
    coverage: healthyCoverage,
    nowMs: julyMs,
  });
  check(
    "gates: the second soft rejection in a row pages",
    !secondJump.accepted && pageReasonsOf(secondJump).length === 1
  );

  const worseError = judgeSolarRefit({
    computation: computation({ candidateMae: 4.3 }),
    incumbent,
    consecutiveRejections: 0,
    specs,
    coverage: healthyCoverage,
    nowMs: julyMs,
  });
  check("gates: a fit worse on the trailing year is rejected", !worseError.accepted);

  const stringDown = judgeSolarRefit({
    computation: computation({ level1: 0.6 }),
    incumbent,
    consecutiveRejections: 0,
    specs,
    coverage: healthyCoverage,
    nowMs: julyMs,
  });
  check(
    "gates: a string far below the model in summer pages (fit still accepted)",
    stringDown.accepted && pageReasonsOf(stringDown).some(reason => reason.includes("90 days"))
  );
  const winterLow = judgeSolarRefit({
    computation: computation({ level1: 0.4 }),
    incumbent,
    consecutiveRejections: 0,
    specs,
    coverage: healthyCoverage,
    nowMs: januaryMs,
  });
  check(
    "gates: the same deficit in January (snow) stays quiet",
    winterLow.accepted && !pageReasonsOf(winterLow).length
  );

  const firstLow = judgeSolarRefit({
    computation: computation({ level1: 0.88 }),
    incumbent,
    consecutiveRejections: 0,
    specs,
    coverage: healthyCoverage,
    nowMs: julyMs,
  });
  check("gates: one level reading outside the deadband changes nothing", firstLow.levels.string1.multiplier === 1);
  const withHistory = {
    ...incumbent,
    strings: {
      ...incumbent.strings,
      string1: { ...incumbent.strings.string1, level_ratios: firstLow.levels.string1.ratios },
    },
  };
  const secondLow = judgeSolarRefit({
    computation: computation({ level1: 0.89 }),
    incumbent: withHistory,
    consecutiveRejections: 0,
    specs,
    coverage: healthyCoverage,
    nowMs: julyMs,
  });
  check(
    "gates: two in a row become the level multiplier",
    Math.abs(secondLow.levels.string1.multiplier - 0.89) < 1e-9,
    `(${secondLow.levels.string1.multiplier})`
  );
  const winterFrozen = judgeSolarRefit({
    computation: computation({ level1: 0.5 }),
    incumbent: {
      ...incumbent,
      strings: { ...incumbent.strings, string1: { ...incumbent.strings.string1, level_multiplier: 0.9 } },
    },
    consecutiveRejections: 0,
    specs,
    coverage: healthyCoverage,
    nowMs: januaryMs,
  });
  check("gates: the level multiplier is frozen through winter", winterFrozen.levels.string1.multiplier === 0.9);
  check(
    "gates: the repeated-rejection page tells how to accept a changed plant",
    pageReasonsOf(secondJump).some(reason => reason.includes("delete backend/solar_model_state.json"))
  );
}

console.log(fails.length ? `\n${fails.length} FAILURES: ${fails.join(", ")}` : "\nAll scenarios passed");
process.exit(fails.length ? 1 : 0);

/** Deterministic weather over `days` days: Haurwitz clear sky scaled by a pseudo-random clearness per hour. */
function syntheticDataset(
  truth: { k: number; sky_factor: number; mask: number[][]; ceiling_watts: number },
  days: number
): SolarFitDataset {
  const startMs = Date.parse("2025-03-01T00:00:00Z");
  const hourCount = days * 24;
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const columns = () => ({
    globalHorizontal: new Float64Array(hourCount),
    diffuseHorizontal: new Float64Array(hourCount),
    directHorizontal: new Float64Array(hourCount),
  });
  const dataset: SolarFitDataset = {
    hourStartMs: new Float64Array(hourCount),
    sunAzimuthDegrees: new Float64Array(hourCount * SUBSTEPS_PER_HOUR),
    sunElevationDegrees: new Float64Array(hourCount * SUBSTEPS_PER_HOUR),
    extraterrestrial: new Float64Array(hourCount),
    physical: columns(),
    forecast: columns(),
    snowOnGround: new Uint8Array(hourCount),
    strings: {
      string1: {
        hourlyWatts: new Float64Array(hourCount).fill(Number.NaN),
        substepWatts: new Float64Array(hourCount * SUBSTEPS_PER_HOUR).fill(Number.NaN),
        usable: new Uint8Array(hourCount),
      },
      string2: {
        hourlyWatts: new Float64Array(hourCount).fill(Number.NaN),
        substepWatts: new Float64Array(hourCount * SUBSTEPS_PER_HOUR).fill(Number.NaN),
        usable: new Uint8Array(hourCount),
      },
    },
  };
  for (let hour = 0; hour < hourCount; hour++) {
    const hourStartMs = startMs + hour * HOUR_MS;
    const sun = hourSun(hourStartMs, LATITUDE, LONGITUDE);
    dataset.hourStartMs[hour] = hourStartMs;
    dataset.sunAzimuthDegrees.set(sun.azimuthDegrees, hour * SUBSTEPS_PER_HOUR);
    dataset.sunElevationDegrees.set(sun.elevationDegrees, hour * SUBSTEPS_PER_HOUR);
    dataset.extraterrestrial[hour] = sun.extraterrestrial;
    const clearSky =
      sun.elevationDegrees
        .map(elevation => Math.max(Math.sin((elevation * Math.PI) / 180), 0))
        .reduce((sum, sinElevation) => sum + 1098 * sinElevation * Math.exp(-0.057 / Math.max(sinElevation, 0.01)), 0) /
      SUBSTEPS_PER_HOUR;
    const clearness = random() < 0.4 ? 0.95 : 0.2 + 0.6 * random();
    const globalHorizontal = clearSky * clearness;
    const directHorizontal = globalHorizontal * Math.max(0, (clearness - 0.25) / 0.75) * 0.85;
    const radiation = { globalHorizontal, directHorizontal, diffuseHorizontal: globalHorizontal - directHorizontal };
    for (const source of [dataset.physical, dataset.forecast]) {
      source.globalHorizontal[hour] = radiation.globalHorizontal;
      source.directHorizontal[hour] = radiation.directHorizontal;
      source.diffuseHorizontal[hour] = radiation.diffuseHorizontal;
    }
    const watts = stringSubstepWatts(poaTerms(sun, radiation, 36, 180), sun, truth, false);
    dataset.strings.string1.substepWatts.set(watts, hour * SUBSTEPS_PER_HOUR);
    dataset.strings.string1.hourlyWatts[hour] = watts.reduce((sum, value) => sum + value, 0) / SUBSTEPS_PER_HOUR;
    dataset.strings.string1.usable[hour] = sun.elevationDegrees.some(elevation => elevation > 0) ? 1 : 0;
  }
  return dataset;
}

function fitResult(physicalK: number) {
  return {
    physical_k: physicalK,
    physical_sky_factor: 0.9,
    forecast_k: physicalK * 0.92,
    forecast_sky_factor: 1.3,
    mask: unshadedMask(),
    mask_sample_counts: [],
    fit_hours: 9000,
  };
}

function pageReasonsOf(judgement: RefitJudgement): string[] {
  return Object.values(judgement.pages).flat();
}

function incumbentState(): SolarModelFit {
  const stringFit = {
    physical_k: 8.9,
    physical_sky_factor: 0.9,
    forecast_k: 8.1,
    forecast_sky_factor: 1.4,
    mask: unshadedMask(),
    mask_sample_counts: [],
    level_multiplier: 1,
    level_ratios: [],
  };
  return {
    fitted_at: "2026-06-03T01:40:00.000Z",
    mask_irradiance_source: "satellite",
    geometry: {
      string1: { tilt_degrees: 36, azimuth_degrees: 180 },
      string2: { tilt_degrees: 45, azimuth_degrees: 300 },
    },
    strings: { string1: stringFit, string2: { ...stringFit, physical_k: 5.6, forecast_k: 5.1 } },
    fit_hours: { string1: 10000, string2: 9000 },
    trailing_year_daily_mae_kwh: 4,
  };
}
