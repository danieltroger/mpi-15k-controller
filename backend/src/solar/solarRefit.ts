import type Influx from "influx";
import type { Config } from "../config/config.types.ts";
import { errorLog, logLog, warnLog } from "../utilities/logging.ts";
import { fetchRadiationArchive, type RadiationArchiveSource } from "./openMeteoClient.ts";
import { queryPvHistory } from "./pvHistory.ts";
import { buildSolarFitDataset } from "./solarFitDataset.ts";
import { runSolarRefitInWorker } from "./solarFitRunner.ts";
import { judgeSolarRefit, type RefitJudgement } from "./solarRefitGates.ts";
import type { SolarRefitOutput } from "./solarRefitComputation.ts";
import { loadSolarModelState, saveSolarModelState } from "./solarModelStore.ts";
import { fittedGeometryMatches, stringGeometries } from "./solarModelGeometry.ts";
import type { SolarModelState, SolarStringKey } from "./solarModel.types.ts";

/**
 * One refit: read the whole production history and both irradiance archives, fit in a worker,
 * judge the candidate (solarRefitGates.ts) and persist it if accepted. Pages (errorLog → P2) only
 * on the gates' real-failure reasons; everything else warns. Throws on fetch/query failures —
 * the scheduler decides whether a failure has lasted long enough to page.
 */
export async function refitSolarModel(input: {
  config: Config;
  influxClient: Influx.InfluxDB;
  nowMs: number;
  /** false = dry run (the CLI): judge and report, but don't persist */
  persist: boolean;
}): Promise<{ judgement: RefitJudgement; computation: SolarRefitOutput; state: SolarModelState | undefined }> {
  const tradingConfig = input.config.automatic_trading;
  const solarModel = tradingConfig.solar_model;
  const fromMs = Date.parse(solarModel.history_start);
  const toMs = Math.floor(input.nowMs / 3600_000) * 3600_000;
  if (!Number.isFinite(fromMs))
    throw new Error(`solar_model.history_start "${solarModel.history_start}" is not a date`);
  const startedAtMs = Date.now();

  const history = await queryPvHistory(input.influxClient, fromMs, toMs);
  const location = { latitude: tradingConfig.latitude, longitude: tradingConfig.longitude };
  const forecastRadiation = await fetchRadiationArchive({ source: "forecast_archive", ...location, fromMs, toMs });
  const { radiation: physicalRadiation, source: maskSource } = await fetchPhysicalRadiation({
    preferred: solarModel.mask_irradiance_source,
    forecastRadiation,
    archive: { ...location, fromMs, toMs },
  });
  const rewiredAtMs = solarModel.rewired_at ? Date.parse(solarModel.rewired_at) : Number.NaN;
  const { dataset, completeHours } = buildSolarFitDataset({
    history,
    physicalRadiation,
    forecastRadiation,
    ...location,
    rewiredAtMs,
  });
  const loadedAtMs = Date.now();

  const stored = await loadSolarModelState();
  const incumbent = stored && fittedGeometryMatches(stored, solarModel) ? stored : undefined;
  const geometry = stringGeometries(solarModel);
  const computation = await runSolarRefitInWorker({
    dataset,
    geometry,
    nowMs: input.nowMs,
    halfLifeDays: solarModel.mask_half_life_days > 0 ? solarModel.mask_half_life_days : null,
    incumbent,
  });
  const judgement = judgeSolarRefit({
    computation,
    incumbent,
    specs: { string1: solarModel.string1, string2: solarModel.string2 },
    coverage: coverageOf(dataset.hourStartMs, completeHours, input.nowMs),
    nowMs: input.nowMs,
  });
  logLog(
    `Solar model: refit computed in ${((Date.now() - loadedAtMs) / 1000).toFixed(1)} s (data ${((loadedAtMs - startedAtMs) / 1000).toFixed(1)} s, mask on ${maskSource}) —`,
    describeComputation(computation),
    judgement.accepted ? "→ accepted" : "→ rejected"
  );
  for (const reason of judgement.warnReasons) warnLog("Solar model refit:", reason);
  for (const reason of judgement.pageReasons) errorLog("Solar model refit:", reason);

  const attempt = {
    at: new Date(input.nowMs).toISOString(),
    outcome: judgement.accepted ? ("accepted" as const) : ("rejected" as const),
    reason: [...judgement.pageReasons, ...judgement.warnReasons].join("; ") || undefined,
  };
  const state: SolarModelState | undefined = judgement.accepted
    ? acceptedState({ computation, judgement, solarModelGeometry: geometry, maskSource, attempt, nowMs: input.nowMs })
    : incumbent && { ...incumbent, consecutive_rejections: judgement.consecutiveRejections, last_attempt: attempt };
  if (input.persist && state) await saveSolarModelState(state);
  return { judgement, computation, state };
}

/** Satellite by default; the forecast archive if the satellite API fails (backtest: costs ±0.5 %). */
async function fetchPhysicalRadiation(input: {
  preferred: RadiationArchiveSource;
  forecastRadiation: Awaited<ReturnType<typeof fetchRadiationArchive>>;
  archive: { latitude: number; longitude: number; fromMs: number; toMs: number };
}): Promise<{
  radiation: Awaited<ReturnType<typeof fetchRadiationArchive>>;
  source: SolarModelState["mask_irradiance_source"];
}> {
  if (input.preferred === "forecast_archive") return { radiation: input.forecastRadiation, source: "forecast_archive" };
  try {
    return { radiation: await fetchRadiationArchive({ source: "satellite", ...input.archive }), source: "satellite" };
  } catch (error) {
    warnLog("Solar model: satellite irradiance unavailable, fitting the mask on the forecast archive instead", error);
    return { radiation: input.forecastRadiation, source: "forecast_archive" };
  }
}

function acceptedState(input: {
  computation: SolarRefitOutput;
  judgement: RefitJudgement;
  solarModelGeometry: ReturnType<typeof stringGeometries>;
  maskSource: SolarModelState["mask_irradiance_source"];
  attempt: NonNullable<SolarModelState["last_attempt"]>;
  nowMs: number;
}): SolarModelState {
  const strings = {} as SolarModelState["strings"];
  const fitHours = {} as SolarModelState["fit_hours"];
  const geometry = {} as SolarModelState["geometry"];
  for (const stringKey of ["string1", "string2"] as const) {
    const { fit } = input.computation.strings[stringKey];
    strings[stringKey] = {
      physical_k: round(fit.physical_k, 4),
      physical_sky_factor: round(fit.physical_sky_factor, 4),
      forecast_k: round(fit.forecast_k, 4),
      forecast_sky_factor: round(fit.forecast_sky_factor, 4),
      mask: fit.mask.map(row => row.map(value => round(value, 3))),
      mask_sample_counts: fit.mask_sample_counts,
      level_multiplier: round(input.judgement.levels[stringKey].multiplier, 4),
      level_ratios: input.judgement.levels[stringKey].ratios.map(entry => ({
        at: entry.at,
        ratio: entry.ratio === null ? null : round(entry.ratio, 4),
      })),
    };
    fitHours[stringKey] = fit.fit_hours;
    geometry[stringKey] = {
      tilt_degrees: input.solarModelGeometry[stringKey].tilt_degrees,
      azimuth_degrees: input.solarModelGeometry[stringKey].azimuth_degrees,
    };
  }
  return {
    version: 1,
    fitted_at: new Date(input.nowMs).toISOString(),
    mask_irradiance_source: input.maskSource,
    geometry,
    strings,
    fit_hours: fitHours,
    trailing_year_daily_mae_kwh:
      input.computation.trailing_year.candidate_mae_kwh === null
        ? null
        : round(input.computation.trailing_year.candidate_mae_kwh, 3),
    consecutive_rejections: 0,
    last_attempt: input.attempt,
  };
}

function coverageOf(hourStartMs: Float64Array, completeHours: Uint8Array, nowMs: number) {
  const recentFromMs = nowMs - 60 * 86_400_000;
  let recentHours = 0;
  let recentComplete = 0;
  let complete = 0;
  hourStartMs.forEach((startMs, hour) => {
    complete += completeHours[hour];
    if (startMs < recentFromMs) return;
    recentHours += 1;
    recentComplete += completeHours[hour];
  });
  return {
    recentCompleteShare: recentHours ? recentComplete / recentHours : 0,
    completeDays: Math.floor(complete / 24),
  };
}

function describeComputation(computation: SolarRefitOutput): string {
  const strings = (["string1", "string2"] as SolarStringKey[]).map(stringKey => {
    const { fit, level } = computation.strings[stringKey];
    return `${stringKey} k ${fit.physical_k.toFixed(2)} (forecast ${fit.forecast_k.toFixed(2)}, sky ${fit.forecast_sky_factor.toFixed(2)}), level ${level.ratio?.toFixed(3) ?? "n/a"}`;
  });
  const { candidate_mae_kwh, incumbent_mae_kwh, days } = computation.trailing_year;
  return `${strings.join("; ")}; trailing-year daily MAE ${candidate_mae_kwh?.toFixed(2) ?? "?"} kWh (current ${incumbent_mae_kwh?.toFixed(2) ?? "none"}, ${days} days)`;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
