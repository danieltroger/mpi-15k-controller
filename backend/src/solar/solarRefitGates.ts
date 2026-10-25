import type { SolarStringSpec } from "../config/config.types.ts";
import type { SolarRefitOutput } from "./solarRefitComputation.ts";
import type { SolarModelFit, SolarRefitPageKind, SolarStringKey } from "./solarModel.types.ts";

/**
 * Accept/reject a candidate refit. Only failures that mean something real page (P2):
 *  - data broken: under 70 % of the last 60 days' hours have complete telemetry
 *  - fitted capacity outside 50–105 % of nameplate (wrong data, mislabelled connector, dead string)
 *  - the candidate rejected twice in a row by the soft checks (capacity moved > 10 % in a month,
 *    mask changes annual energy > 5 %, or trailing-year daily error > 3 % worse than the incumbent)
 *  - the 90-day production level outside ±20 % of the model in March–October (string down, new shade)
 * The old gate (hourly R² ≥ 0.6 on 45 days) failed on winter cloud noise alone: 22 of 59 refits.
 * Everything here judges whole years or physical bounds, so ordinary winter noise can't trip it.
 * The caller pages each kind once per episode (pageOncePerEpisode in solarRefit.ts), not on every retry.
 */
export function judgeSolarRefit(input: {
  computation: SolarRefitOutput;
  incumbent: SolarModelFit | undefined;
  /** Soft rejections in a row so far (from the persisted refit status) */
  consecutiveRejections: number;
  specs: Record<SolarStringKey, SolarStringSpec>;
  coverage: { recentCompleteShare: number; completeDays: number };
  nowMs: number;
}): RefitJudgement {
  const hardFailures: string[] = [];
  const softReasons: string[] = [];
  const levelAlarms: string[] = [];
  if (input.coverage.recentCompleteShare < MIN_RECENT_COMPLETE_SHARE) {
    hardFailures.push(
      `only ${percent(input.coverage.recentCompleteShare)} of the last 60 days have complete inverter telemetry in InfluxDB — logging looks broken`
    );
  }
  if (input.coverage.completeDays < MIN_COMPLETE_DAYS) {
    return {
      accepted: false,
      hardFailure: hardFailures.length > 0,
      pages: hardFailures.length ? { hard_failure: hardFailures } : {},
      warnReasons: [`only ${input.coverage.completeDays} days of complete history — need ${MIN_COMPLETE_DAYS} to fit`],
      levels: currentLevels(input.incumbent),
      consecutiveRejections: input.consecutiveRejections,
    };
  }
  for (const stringKey of ["string1", "string2"] as const) {
    const { fit, capacity_change, mask_energy_change } = input.computation.strings[stringKey];
    const nameplate = input.specs[stringKey].nameplate_kwp;
    const capacityShare = fit.physical_k / nameplate;
    if (!(capacityShare >= MIN_CAPACITY_SHARE && capacityShare <= MAX_CAPACITY_SHARE)) {
      hardFailures.push(
        `${stringKey} fitted at ${fit.physical_k.toFixed(2)} kW per kW/m², ${percent(capacityShare)} of its ${nameplate} kWp nameplate — check the data, the connector mapping and the string itself`
      );
    }
    if (capacity_change !== null && Math.abs(capacity_change) > MAX_MONTHLY_CAPACITY_CHANGE) {
      softReasons.push(`${stringKey} capacity moved ${signedPercent(capacity_change)} in one refit`);
    }
    if (mask_energy_change !== null && Math.abs(mask_energy_change) > MAX_MASK_ENERGY_CHANGE) {
      softReasons.push(`${stringKey} shading mask changes annual energy by ${signedPercent(mask_energy_change)}`);
    }
  }
  const { candidate_mae_kwh, incumbent_mae_kwh } = input.computation.trailing_year;
  if (
    candidate_mae_kwh !== null &&
    incumbent_mae_kwh !== null &&
    candidate_mae_kwh > incumbent_mae_kwh * MAX_ERROR_GROWTH
  ) {
    softReasons.push(
      `trailing-year daily error ${candidate_mae_kwh.toFixed(2)} kWh vs ${incumbent_mae_kwh.toFixed(2)} for the current fit`
    );
  }
  const levels = nextLevels(input.computation, input.incumbent, input.nowMs);
  for (const stringKey of ["string1", "string2"] as const) {
    const ratio = input.computation.strings[stringKey].level.ratio;
    if (ratio !== null && levelCheckSeason(input.nowMs) && (ratio < MIN_LEVEL_RATIO || ratio > MAX_LEVEL_RATIO)) {
      levelAlarms.push(
        `${stringKey} produced ${percent(ratio)} of the model over the last 90 days — a string down, new shade, soiling or snow?`
      );
    }
  }
  const rejected = hardFailures.length > 0 || softReasons.length > 0;
  const consecutiveRejections = softReasons.length ? input.consecutiveRejections + 1 : 0;
  const repeatedRejection =
    consecutiveRejections >= PAGE_AFTER_REJECTIONS
      ? [
          `refit rejected ${consecutiveRejections} times in a row (${softReasons.join("; ")}). ` +
            `If the plant really changed (panels moved, a tree cut down), delete backend/solar_model_state.json — ` +
            `the controller notices within the hour and fits from scratch, no restart needed`,
        ]
      : [];
  const pages: RefitJudgement["pages"] = {};
  if (hardFailures.length) pages.hard_failure = hardFailures;
  if (levelAlarms.length) pages.level = levelAlarms;
  if (repeatedRejection.length) pages.repeated_rejection = repeatedRejection;
  return {
    accepted: !rejected,
    hardFailure: hardFailures.length > 0,
    pages,
    warnReasons: repeatedRejection.length ? [] : softReasons,
    levels,
    consecutiveRejections,
  };
}

export type RefitJudgement = {
  accepted: boolean;
  /** A hard failure (broken data, implausible capacity) — retried with back-off, not on the monthly cadence */
  hardFailure: boolean;
  /** Page-worthy reasons by kind; each kind becomes one errorLog (= P2) per episode */
  pages: Partial<Record<Exclude<SolarRefitPageKind, "failing">, string[]>>;
  /** Rejection reasons that only warn (a first soft rejection, too little history) */
  warnReasons: string[];
  levels: Record<SolarStringKey, { multiplier: number; ratios: { at: string; ratio: number | null }[] }>;
  consecutiveRejections: number;
};

const MIN_RECENT_COMPLETE_SHARE = 0.7;
const MIN_COMPLETE_DAYS = 60;
const MIN_CAPACITY_SHARE = 0.5;
const MAX_CAPACITY_SHARE = 1.05;
const MAX_MONTHLY_CAPACITY_CHANGE = 0.1;
const MAX_MASK_ENERGY_CHANGE = 0.05;
const MAX_ERROR_GROWTH = 1.03;
const PAGE_AFTER_REJECTIONS = 2;
const MIN_LEVEL_RATIO = 0.8;
const MAX_LEVEL_RATIO = 1.2;
/**
 * A persistent level shift (two refits in a row beyond ±8 %) becomes a forecast multiplier until
 * the recency-weighted fit absorbs it. Backtest: 10 % uniform loss tracked within 1–2 sunny months;
 * on the real history the rule would never have fired (string 1 left ±8 % once, April 2026, for one month).
 */
const LEVEL_DEADBAND = 0.08;
const LEVEL_HISTORY_LENGTH = 6;

function nextLevels(
  computation: SolarRefitOutput,
  incumbent: SolarModelFit | undefined,
  nowMs: number
): RefitJudgement["levels"] {
  const levels = {} as RefitJudgement["levels"];
  for (const stringKey of ["string1", "string2"] as const) {
    const ratio = levelCheckSeason(nowMs) ? computation.strings[stringKey].level.ratio : null;
    const ratios = [
      ...(incumbent?.strings[stringKey].level_ratios ?? []),
      { at: new Date(nowMs).toISOString(), ratio },
    ].slice(-LEVEL_HISTORY_LENGTH);
    const latest = ratios[ratios.length - 1].ratio;
    const previous = ratios.length >= 2 ? ratios[ratios.length - 2].ratio : null;
    const persistentlyOutside =
      previous !== null &&
      latest !== null &&
      Math.abs(previous - 1) > LEVEL_DEADBAND &&
      Math.abs(latest - 1) > LEVEL_DEADBAND &&
      Math.sign(previous - 1) === Math.sign(latest - 1);
    // In winter the level is frozen at whatever it was, not reset
    const frozen = latest === null ? incumbent?.strings[stringKey].level_multiplier ?? 1 : undefined;
    levels[stringKey] = {
      multiplier:
        frozen ??
        (persistentlyOutside && latest !== null ? Math.min(Math.max(latest, MIN_LEVEL_RATIO), MAX_LEVEL_RATIO) : 1),
      ratios,
    };
  }
  return levels;
}

function currentLevels(incumbent: SolarModelFit | undefined): RefitJudgement["levels"] {
  const levels = {} as RefitJudgement["levels"];
  for (const stringKey of ["string1", "string2"] as const) {
    levels[stringKey] = {
      multiplier: incumbent?.strings[stringKey].level_multiplier ?? 1,
      ratios: incumbent?.strings[stringKey].level_ratios ?? [],
    };
  }
  return levels;
}

/** March–October: enough sun for a 90-day ratio to mean something; winter windows are snow and noise */
function levelCheckSeason(nowMs: number): boolean {
  const month = new Date(nowMs).getUTCMonth() + 1;
  return month >= 3 && month <= 10;
}

function percent(share: number): string {
  return `${Math.round(share * 100)} %`;
}

function signedPercent(change: number): string {
  return `${change >= 0 ? "+" : ""}${Math.round(change * 100)} %`;
}
