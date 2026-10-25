import { performance } from "perf_hooks";
import type { Config } from "../config/config.types.ts";
import { errorLog, logLog, warnLog } from "../utilities/logging.ts";
import { runSolarRefitInChildProcess } from "./solarRefitRunner.ts";
import { describeError } from "./errorDescription.ts";
import { judgeSolarRefit, type RefitJudgement } from "./solarRefitGates.ts";
import type { SolarRefitJobResult } from "./solarRefitJob.ts";
import { loadSolarModelState, saveSolarModelState } from "./solarModelStore.ts";
import { fittedGeometryMatches, stringGeometries } from "./solarModelGeometry.ts";
import type {
  SolarModelFit,
  SolarModelState,
  SolarRefitPageKind,
  SolarRefitStatus,
  SolarStringKey,
} from "./solarModel.types.ts";

/**
 * One refit: a child process does all the heavy lifting (solarRefitJob.ts); here the candidate is
 * judged (solarRefitGates.ts), paged about at most once per episode per kind, and persisted —
 * the refit status too, even when nothing was fitted, so retries back off (3 h → 12 h → daily)
 * instead of re-running and re-paging every few hours. Concurrent calls join the one in flight
 * (module-level, so it holds across index.ts's in-process main() restarts), and a result never
 * overwrites a newer fit someone else wrote meanwhile (the CLI bootstrap).
 */
export function refitSolarModel(input: { config: Config; nowMs: number; persist: boolean }): Promise<RefitOutcome> {
  refitInFlight ??= performRefit(input).finally(() => (refitInFlight = undefined));
  return refitInFlight;
}

export type RefitOutcome = {
  judgement: RefitJudgement | undefined;
  result: SolarRefitJobResult | undefined;
  state: SolarModelState;
  error?: unknown;
  /** Synchronous controller-side work: forking the child, and judging + building the state */
  controllerBlockMs?: { spawn: number; judge: number };
};

let refitInFlight: Promise<RefitOutcome> | undefined;

/** Retry spacing after hard rejections and thrown errors: 3 h, 12 h, then daily */
const FAILURE_BACKOFF_MS = [3 * 3600_000, 12 * 3600_000, 24 * 3600_000];
/** A fit this much older than refit_every_days pages when refits keep failing */
const OVERDUE_GRACE_DAYS = 7;
/** With no fit at all, failing for this long pages */
const UNFITTED_FAILING_PAGE_MS = 86_400_000;

async function performRefit(input: { config: Config; nowMs: number; persist: boolean }): Promise<RefitOutcome> {
  const { config, nowMs } = input;
  const solarModel = config.automatic_trading.solar_model;
  const stored = await loadSolarModelState();
  // Identity of what this refit started from: a file copied in or deleted meanwhile must win
  const startedFromFittedAt = stored?.fit?.fitted_at;
  const incumbent = stored?.fit && fittedGeometryMatches(stored.fit, solarModel) ? stored.fit : undefined;
  const status: SolarRefitStatus = structuredClone(stored?.refit ?? emptyRefitStatus());
  const persist = async (state: SolarModelState) => {
    if (input.persist) await persistIfUnchanged(state, startedFromFittedAt);
  };
  let result: SolarRefitJobResult & { controller_spawn_ms: number };
  try {
    if (!config.influxdb) throw new Error("InfluxDB is not configured");
    result = await runSolarRefitInChildProcess({
      influxdb: config.influxdb,
      latitude: config.automatic_trading.latitude,
      longitude: config.automatic_trading.longitude,
      solar_model: solarModel,
      full_battery_voltage: config.full_battery_voltage,
      nowMs,
      incumbent,
    });
  } catch (error) {
    recordFailure(status, { nowMs, incumbent, refit_every_days: solarModel.refit_every_days, error });
    const state: SolarModelState = { version: 2, fit: stored?.fit, refit: status };
    await persist(state);
    return { judgement: undefined, result: undefined, state, error };
  }
  let concluded: ReturnType<typeof concludeRefit>;
  try {
    concluded = concludeRefit({ result, incumbent, stored, status, solarModel, nowMs });
  } catch (error) {
    // A bug in judging or building the fit gets the same back-off and once-per-episode page as a failed child
    const failedStatus: SolarRefitStatus = structuredClone(stored?.refit ?? emptyRefitStatus());
    // Pages concludeRefit already sent before throwing stay recorded, so a retry doesn't repeat them
    // (merged, not replaced: a re-arm concludeRefit did before throwing must not re-arm here)
    failedStatus.paged = { ...failedStatus.paged, ...status.paged };
    recordFailure(failedStatus, { nowMs, incumbent, refit_every_days: solarModel.refit_every_days, error });
    const state: SolarModelState = { version: 2, fit: stored?.fit, refit: failedStatus };
    await persist(state);
    return { judgement: undefined, result, state, error };
  }
  await persist(concluded.state);
  return { ...concluded, result };
}

/** Synchronous: judge the child's result, page, and build the next state. */
function concludeRefit(input: {
  result: SolarRefitJobResult & { controller_spawn_ms: number };
  incumbent: SolarModelFit | undefined;
  stored: SolarModelState | undefined;
  status: SolarRefitStatus;
  solarModel: Config["automatic_trading"]["solar_model"];
  nowMs: number;
}): Omit<RefitOutcome, "result"> & { state: SolarModelState } {
  const { result, incumbent, status, solarModel, nowMs } = input;
  const judgingStartedMs = performance.now();
  if (result.satellite_error) {
    warnLog(
      "Solar model: satellite irradiance unavailable, fitted the mask on the forecast archive",
      result.satellite_error
    );
  }
  const judgement = judgeSolarRefit({
    computation: result.computation,
    incumbent,
    consecutiveRejections: status.consecutive_rejections,
    specs: { string1: solarModel.string1, string2: solarModel.string2 },
    coverage: result.coverage,
    nowMs,
  });
  logLog(
    `Solar model: refit (child process: data ${(result.load_ms / 1000).toFixed(1)} s, fit ${(result.compute_ms / 1000).toFixed(1)} s, ` +
      `heap peak ${result.peak_heap_used_mb} MB, RSS peak ${result.peak_rss_mb} MB, mask on ${result.mask_irradiance_source}) —`,
    describeComputation(result),
    judgement.accepted ? "→ accepted" : "→ rejected"
  );
  for (const reason of judgement.warnReasons) warnLog("Solar model refit:", reason);
  recordCompletedRefit(status, judgement, { incumbent, nowMs });
  const fit = judgement.accepted ? acceptedFit(result, judgement, solarModel, nowMs) : input.stored?.fit;
  return {
    judgement,
    state: { version: 2, fit, refit: status },
    controllerBlockMs: {
      spawn: Math.round(result.controller_spawn_ms * 10) / 10,
      judge: Math.round((performance.now() - judgingStartedMs) * 10) / 10,
    },
  };
}

/**
 * The bookkeeping after a refit the child completed: pages (once per episode), outcome, and the
 * back-off for hard failures. Only an accepted or soft-rejected refit ends a "refits keep failing"
 * episode — a hard rejection (e.g. low telemetry coverage, which a flaky Influx causes along with
 * the thrown failures) must not re-arm that page between two failing nights.
 */
export function recordCompletedRefit(
  status: SolarRefitStatus,
  judgement: RefitJudgement,
  context: { incumbent: SolarModelFit | undefined; nowMs: number }
) {
  pageOncePerEpisode(status, judgement.pages, context.nowMs);
  const reasons = [...Object.values(judgement.pages).flat(), ...judgement.warnReasons];
  status.last_attempt_at = new Date(context.nowMs).toISOString();
  status.last_outcome = judgement.accepted ? "accepted" : "rejected";
  status.last_reason = reasons.join("; ") || undefined;
  status.consecutive_rejections = judgement.consecutiveRejections;
  const unfittedRejection = !judgement.accepted && !context.incumbent;
  if (judgement.hardFailure || unfittedRejection) {
    status.consecutive_failures += 1;
    status.next_attempt_at = backoffUntil(context.nowMs, status.consecutive_failures);
  } else {
    status.consecutive_failures = 0;
    status.next_attempt_at = undefined;
    status.failing_since = undefined;
    delete status.paged.failing;
  }
}

/** Each kind pages once, then only warns until a refit without that kind of problem re-arms it. */
export function pageOncePerEpisode(status: SolarRefitStatus, pages: RefitJudgement["pages"], nowMs: number) {
  for (const kind of ["hard_failure", "level", "repeated_rejection"] as const) {
    const reasons = pages[kind];
    if (!reasons?.length) {
      delete status.paged[kind];
      continue;
    }
    if (status.paged[kind]) {
      for (const reason of reasons) warnLog(`Solar model refit (already paged ${status.paged[kind]}):`, reason);
      continue;
    }
    for (const reason of reasons) errorLog("Solar model refit:", reason);
    status.paged[kind] = new Date(nowMs).toISOString();
  }
}

/** A failed refit (Influx/open-meteo down, the child died, judging threw): back off; page once if overdue. */
export function recordFailure(
  status: SolarRefitStatus,
  input: { nowMs: number; incumbent: SolarModelFit | undefined; refit_every_days: number; error: unknown }
) {
  status.last_attempt_at = new Date(input.nowMs).toISOString();
  status.last_outcome = "failed";
  status.last_reason = describeError(input.error);
  status.failing_since ??= status.last_attempt_at;
  status.consecutive_failures += 1;
  status.next_attempt_at = backoffUntil(input.nowMs, status.consecutive_failures);
  const overdue = input.incumbent
    ? input.nowMs - Date.parse(input.incumbent.fitted_at) > (input.refit_every_days + OVERDUE_GRACE_DAYS) * 86_400_000
    : input.nowMs - Date.parse(status.failing_since) >= UNFITTED_FAILING_PAGE_MS;
  const page: SolarRefitPageKind = "failing";
  if (overdue && !status.paged[page]) {
    errorLog(
      input.incumbent
        ? `Solar model: refits keep failing and the fit is now ${Math.round((input.nowMs - Date.parse(input.incumbent.fitted_at)) / 86_400_000)} days old: ${status.last_reason}`
        : `Solar model: no fit for a day — forecasting on the default horizon mask: ${status.last_reason}`
    );
    status.paged[page] = status.last_attempt_at;
  } else {
    warnLog(
      `Solar model: refit failed (attempt ${status.consecutive_failures}, retry after ${status.next_attempt_at}): ${status.last_reason}`
    );
  }
}

/**
 * Saves unless the file no longer holds the fit this refit started from: a bootstrap copied in, or
 * a file deleted to refit from scratch, must not be overwritten by a refit that began before it.
 * A failed write keeps the state in memory (solarModelStore.ts) and pages once per episode.
 */
export async function persistIfUnchanged(
  state: SolarModelState,
  startedFromFittedAt: string | undefined,
  store: { load: typeof loadSolarModelState; save: typeof saveSolarModelState } = {
    load: loadSolarModelState,
    save: saveSolarModelState,
  }
): Promise<"saved" | "superseded" | "failed"> {
  const current = await store.load();
  if (current?.fit?.fitted_at !== startedFromFittedAt) {
    warnLog(
      `Solar model: the state file changed while this refit ran (fit ${startedFromFittedAt ?? "none"} → ` +
        `${current?.fit?.fitted_at ?? (current ? "none" : "file deleted")}) — keeping the file, discarding this result`
    );
    return "superseded";
  }
  try {
    await store.save(state);
    saveFailurePaged = false;
    return "saved";
  } catch (error) {
    const report = saveFailurePaged ? warnLog : errorLog;
    report("Solar model: failed to write the state file — the new state only lives in memory until restart", error);
    saveFailurePaged = true;
    return "failed";
  }
}

/** Module-level: a failing disk can't record its own page, and this survives in-process main() restarts */
let saveFailurePaged = false;

export function emptyRefitStatus(): SolarRefitStatus {
  return { consecutive_rejections: 0, consecutive_failures: 0, paged: {} };
}

function backoffUntil(nowMs: number, consecutiveFailures: number): string {
  const delayMs = FAILURE_BACKOFF_MS[Math.min(consecutiveFailures, FAILURE_BACKOFF_MS.length) - 1];
  return new Date(nowMs + delayMs).toISOString();
}

function acceptedFit(
  result: SolarRefitJobResult,
  judgement: RefitJudgement,
  solarModel: Config["automatic_trading"]["solar_model"],
  nowMs: number
): SolarModelFit {
  const geometries = stringGeometries(solarModel);
  const strings = {} as SolarModelFit["strings"];
  const fitHours = {} as SolarModelFit["fit_hours"];
  const geometry = {} as SolarModelFit["geometry"];
  for (const stringKey of ["string1", "string2"] as const) {
    const { fit } = result.computation.strings[stringKey];
    strings[stringKey] = {
      physical_k: round(fit.physical_k, 4),
      physical_sky_factor: round(fit.physical_sky_factor, 4),
      forecast_k: round(fit.forecast_k, 4),
      forecast_sky_factor: round(fit.forecast_sky_factor, 4),
      mask: fit.mask.map(row => row.map(value => round(value, 3))),
      mask_sample_counts: fit.mask_sample_counts,
      level_multiplier: round(judgement.levels[stringKey].multiplier, 4),
      level_ratios: judgement.levels[stringKey].ratios.map(entry => ({
        at: entry.at,
        ratio: entry.ratio === null ? null : round(entry.ratio, 4),
      })),
    };
    fitHours[stringKey] = fit.fit_hours;
    geometry[stringKey] = {
      tilt_degrees: geometries[stringKey].tilt_degrees,
      azimuth_degrees: geometries[stringKey].azimuth_degrees,
    };
  }
  const candidateMae = result.computation.trailing_year.candidate_mae_kwh;
  return {
    fitted_at: new Date(nowMs).toISOString(),
    mask_irradiance_source: result.mask_irradiance_source,
    geometry,
    strings,
    fit_hours: fitHours,
    trailing_year_daily_mae_kwh: candidateMae === null ? null : round(candidateMae, 3),
  };
}

function describeComputation(result: SolarRefitJobResult): string {
  const strings = (["string1", "string2"] as SolarStringKey[]).map(stringKey => {
    const { fit, level } = result.computation.strings[stringKey];
    return `${stringKey} k ${fit.physical_k.toFixed(2)} (forecast ${fit.forecast_k.toFixed(2)}, sky ${fit.forecast_sky_factor.toFixed(2)}), level ${level.ratio?.toFixed(3) ?? "n/a"}`;
  });
  const { candidate_mae_kwh, incumbent_mae_kwh, days } = result.computation.trailing_year;
  return `${strings.join("; ")}; trailing-year daily MAE ${candidate_mae_kwh?.toFixed(2) ?? "?"} kWh (current ${incumbent_mae_kwh?.toFixed(2) ?? "none"}, ${days} days)`;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
