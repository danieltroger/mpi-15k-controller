/**
 * The planner's terminal value: what a kWh still in the battery at the end of the simulated horizon is
 * worth. Without it that energy is worth nothing, while the horizon is only the ~35 h of published prices
 * plus the unpriced tail. So the planner never stocked up on a cheap day unless it saw an import inside
 * the horizon, and sold stock it needed right after it (2026-10-28, 88 % SOC: 23.5 kWh planned at
 * 2.2–2.4 SEK down to the floor, right before five days at 1.6–1.85 SEK that the house then imported at
 * ~3.6 SEK/kWh).
 *
 * Backtest 2022-11 → 2026-11 (SE3, the real house load and PV, generatePlan replayed): the trailing 7-day
 * mean at k 0.9 with min_buy_saving_sek_per_kwh 0.1, October–March, saved 21–93 SEK per winter and 66 SEK
 * in autumn 2026, positive in every period. Plain rules (fill below X öre, hold X % SOC, fill to 100 % on a
 * price rise) lost 100–1500 SEK per winter against the planner without them.
 *
 * Where the solar forecast past the horizon refills the battery anyway, the top of it is worth less than V
 * (terminalValueSolar.ts).
 *
 * Pure (type-only imports): the config page shares the knob defaults.
 */
import type { ExpectedSpotSource, TerminalValueMode } from "../config/config.types.ts";
import type { PlannerInput, PlannerKnobs } from "./planner.types.ts";

/** terminal_value_months' default: October–March, the backtested season */
export const DEFAULT_TERMINAL_VALUE_MONTHS = "10,11,12,1,2,3";

/** Every source terminal_value_mode may name; expectedSpot.ts has an estimator for each */
const EXPECTED_SPOT_SOURCES: Record<ExpectedSpotSource, true> = { trailing: true, forecast: true };

export type TerminalValuation = {
  /** p̂, SEK/kWh spot: the unpriced tail is priced at it too */
  expectedSpot: number;
  /** V, SEK per DC kWh above the emergency floor at the end of the horizon (terminalValueSekPerKwh) */
  endEnergySekPerKwh: number;
  /** How the plan note explains V: "7-day mean spot 1.12, k 0.9" */
  basis: string;
};

/**
 * A plan's terminal value, or none: `unavailable` says why when it was asked for (on and in season) but
 * the expected spot is missing.
 */
export type TerminalValuationResult = { valuation?: TerminalValuation; unavailable?: string };

/**
 * Main: the terminal value a plan for this input applies. None when terminal_value_mode is off or the
 * month is outside terminal_value_months (the planner then behaves as without the feature), or when the
 * expected spot is missing.
 */
export function terminalValuationFor(input: PlannerInput): TerminalValuationResult {
  const knobs = input.knobs;
  if (!terminalValueInSeason(knobs, input.nowMs)) return {};
  const estimate = input.expectedSpot;
  if (!estimate) return { unavailable: "no expected spot price was estimated" };
  if (estimate.expectedSpot === undefined) return { unavailable: estimate.detail };
  // A NaN would poison every revenue comparison the passes make
  if (!Number.isFinite(estimate.expectedSpot)) {
    return { unavailable: `the expected spot (${estimate.detail}) is ${estimate.expectedSpot}` };
  }
  return {
    valuation: {
      expectedSpot: estimate.expectedSpot,
      endEnergySekPerKwh: terminalValueSekPerKwh(knobs, estimate.expectedSpot),
      basis: `${estimate.detail} ${estimate.expectedSpot.toFixed(2)}, k ${knobs.terminal_value_scale}`,
    },
  };
}

/**
 * V: SEK per DC kWh above the emergency floor at the end of the plan. A kWh kept past the horizon later
 * covers discharge_efficiency kWh of house load that would otherwise be imported at
 * (p̂ + buy_surcharges_sek_per_kwh) × vat_multiplier; k (terminal_value_scale) discounts that, as p̂ is
 * a guess and some kept energy ends up sold cheaper or still unused. So the planner sells a DC kWh only
 * where discharge_efficiency × (spot + sell_bonus) beats V, i.e. spot + sell_bonus > k × (p̂ + surcharges)
 * × VAT, and buys an AC kWh to keep when charge_efficiency × V beats (spot + surcharges) × VAT by
 * min_buy_saving_sek_per_kwh. Never negative: kept energy can always just sit there.
 */
export function terminalValueSekPerKwh(
  knobs: Pick<
    PlannerKnobs,
    "terminal_value_scale" | "discharge_efficiency" | "buy_surcharges_sek_per_kwh" | "vat_multiplier"
  >,
  expectedSpot: number
): number {
  return Math.max(
    0,
    knobs.terminal_value_scale *
      knobs.discharge_efficiency *
      (expectedSpot + knobs.buy_surcharges_sek_per_kwh) *
      knobs.vat_multiplier
  );
}

/**
 * Whether the terminal value applies at nowMs: terminal_value_mode names a source, and the month (Swedish
 * time) is one of terminal_value_months. plannerInputs.ts estimates the expected spot only then.
 */
export function terminalValueInSeason(
  knobs: Pick<PlannerKnobs, "terminal_value_mode" | "terminal_value_months">,
  nowMs: number
): boolean {
  if (!isExpectedSpotSource(knobs.terminal_value_mode)) return false;
  return parseTerminalValueMonths(knobs.terminal_value_months).months.includes(stockholmMonth(nowMs));
}

export function isExpectedSpotSource(mode: unknown): mode is ExpectedSpotSource {
  return typeof mode === "string" && Object.hasOwn(EXPECTED_SPOT_SOURCES, mode);
}

/** A terminal_value_mode that isn't "off" or a known source is corrected to "off". Takes `unknown`: config.json is hand-editable. */
export function effectiveTerminalValueMode(configured: unknown): {
  value: TerminalValueMode;
  correction: string | undefined;
} {
  if (configured === "off" || isExpectedSpotSource(configured)) return { value: configured, correction: undefined };
  const known = ["off", ...Object.keys(EXPECTED_SPOT_SOURCES)].map(mode => `"${mode}"`).join(", ");
  return { value: "off", correction: `${JSON.stringify(configured)} is not one of ${known}, using "off"` };
}

/**
 * terminal_value_months normalised to its valid entries; entries that aren't whole months 1–12 are
 * dropped, and a value that isn't a string at all falls back to the default.
 */
export function effectiveTerminalValueMonths(configured: unknown): { value: string; correction: string | undefined } {
  if (typeof configured !== "string") {
    return {
      value: DEFAULT_TERMINAL_VALUE_MONTHS,
      correction: `${JSON.stringify(configured)} is not a comma-separated list of month numbers, using the default "${DEFAULT_TERMINAL_VALUE_MONTHS}"`,
    };
  }
  const { months, invalidEntries } = parseTerminalValueMonths(configured);
  if (!invalidEntries.length) return { value: configured, correction: undefined };
  return {
    value: months.join(","),
    correction: `${invalidEntries.map(entry => JSON.stringify(entry)).join(", ")} ${invalidEntries.length === 1 ? "is not a month" : "are not months"} 1–12, ignored`,
  };
}

/** The months (1–12) a terminal_value_months value lists, and the entries that aren't one */
export function parseTerminalValueMonths(configured: unknown): { months: number[]; invalidEntries: string[] } {
  if (typeof configured !== "string") return parseTerminalValueMonths(DEFAULT_TERMINAL_VALUE_MONTHS);
  const months: number[] = [];
  const invalidEntries: string[] = [];
  for (const entry of configured.split(/[\s,;]+/).filter(Boolean)) {
    const month = Number(entry);
    if (Number.isInteger(month) && month >= 1 && month <= 12) {
      if (!months.includes(month)) months.push(month);
    } else {
      invalidEntries.push(entry);
    }
  }
  return { months, invalidEntries };
}

const stockholmMonthFormat = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Stockholm", month: "numeric" });

/** The calendar month (1–12) in Sweden at ms */
export function stockholmMonth(ms: number): number {
  return Number(stockholmMonthFormat.format(ms));
}
