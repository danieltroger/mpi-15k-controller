/**
 * Bounds of the automatic_trading knobs the backend enforces before handing them to the planner, and the
 * correction of a value outside them (config.json is hand-editable; the config page's min/max are only input
 * hints). Pure (type-only imports): the config page shares the bounds.
 */
import type { AutomaticTradingConfig } from "../config/config.types.ts";

export type BoundedPlannerKnobName = keyof Pick<
  AutomaticTradingConfig,
  | "min_sell_power_watts"
  | "fragmentation_tolerance_sek_per_window"
  | "terminal_value_scale"
  | "terminal_value_trailing_days"
  | "terminal_value_min_saving_sek_per_kwh"
  | "terminal_value_forecast_max_deviation_sek"
  | "terminal_value_forecast_max_age_hours"
  | "terminal_value_forecast_wait_seconds"
>;

export type PlannerKnobBounds = {
  defaultValue: number;
  min: number;
  max: number;
  unit: "W" | "SEK" | "×" | "days" | "h" | "s";
  step: number;
};

export const PLANNER_KNOB_BOUNDS = {
  // A leftover budget the greedy can't fit at full power is sold at the largest power that still keeps the
  // reserve floor (sellAllocation.ts). 1.5 kW for 15 min is ~0.37 kWh, under 1 SEK even at a 2.5 SEK peak: around the
  // min-gain bar, so anything smaller is crumbs that still cost a setpoint write and a ramp. The 500 W floor stays
  // clear of the 350 W baseline night feed, which the inverter feeds anyway. At or above max_sell_power_watts
  // the fallback is off: a slot is sold at full power or not at all.
  min_sell_power_watts: { defaultValue: 1500, min: 500, max: 15000, unit: "W", step: 100 },
  // What consolidation may give up per separate selling run it merges away (sellConsolidation.ts). Each
  // run costs a ramp restart and two window-edge writes for real, and the simulation over-credits every
  // 15 kW restart by ~90 Wh (planned at 1.5 kW/min, measured 1.4): ~0.2 SEK at a 2 SEK peak, so a comb
  // that out-earns a merged plan by less than that is model noise. 0 = merge only for a strict gain. Past
  // 1 SEK per run the planner would give up real money to tidy the schedule.
  fragmentation_tolerance_sek_per_window: { defaultValue: 0.2, min: 0, max: 1, unit: "SEK", step: 0.05 },
  // k in the terminal value (terminalValue.ts): the share of the import a kWh left at the end of the plan
  // avoids later. The most robust setting in the 2022-11 → 2026-11 backtest was 0.9 (1.0 lost money in a
  // winter: the expected spot is a guess, and some kept energy is later sold cheaper or idles). 0 values it
  // at nothing. Stocking up pays when charge × k × discharge efficiency × (p̂ + surcharges) beats
  // (spot + surcharges), so past k = 1/(0.95 × 0.93) ≈ 1.13 it buys at more than the import it avoids.
  terminal_value_scale: { defaultValue: 0.9, min: 0, max: 1.1, unit: "×", step: 0.05 },
  // Days the trailing expected spot averages (expectedSpot.ts). 7 was the most robust in the backtest (14 and
  // 30 days each lost money in some winter); 60 days of history is ~60 small one-off fetches.
  terminal_value_trailing_days: { defaultValue: 7, min: 1, max: 60, unit: "days", step: 1 },
  // The margin of the stocking-up block (buyAllocation.ts), the buy made with no import in sight, apart from
  // min_buy_saving_sek_per_kwh so the terminal value doesn't loosen import-averting and arbitrage buys. In
  // the 2022-11 → 2026-11 backtest (both the actual load and the live forecast) no margin came out ahead of
  // leaving that block out: 0.4–1 within ~10 SEK per winter of it, 0.1–0.25 15–90 SEK behind. The gain is in
  // keeping energy and in the averting blocks. At 1 it only stocks up on an outsized gap (≈0 SEK spot against a
  // ~1.5 SEK week). Past 2 it never stocks up.
  terminal_value_min_saving_sek_per_kwh: { defaultValue: 1, min: 0, max: 2, unit: "SEK", step: 0.05 },
  // terminal_value_mode "forecast" (expectedSpotForecast.ts). The outlook works in log(price + 0.3), so a
  // dear D+1 and a big swing in wind or temperature can land far from any recent price. Out of sample
  // (2025-10 → 2026-10) it strayed at most 1.01 SEK from the 7-day mean (99 % within 0.79). In the backtest
  // a 0.75–1 SEK band moved no period's cost by more than 0.1 SEK, while 0.5 cost 13–15 SEK in winter 25/26
  // and 0.25 lost most of the gain: 1 only stops an outlier. 0 = never leave the trailing mean (the outlook is
  // then only reported).
  terminal_value_forecast_max_deviation_sek: { defaultValue: 1, min: 0, max: 3, unit: "SEK", step: 0.05 },
  // The weather forecast's age before a plan fetches a new one; past it, a plan whose refresh fails falls back to
  // the trailing mean. open-meteo's models update every 1–6 h. The out-of-sample skill was measured on forecasts
  // issued the day before, so a few hours cost nothing; 24 h is a forecast a full day old.
  terminal_value_forecast_max_age_hours: { defaultValue: 6, min: 1, max: 24, unit: "h", step: 1 },
  // How long a plan waits for the outlook's inputs before planning on the trailing mean (the fetch carries on
  // for the next plan). One open-meteo call, plus up to ~22 price-history days after a restart; on a CPU-pegged
  // Zero 2 W a TLS connect alone can take seconds. Each request has its own 60 s timeout.
  terminal_value_forecast_wait_seconds: { defaultValue: 30, min: 5, max: 120, unit: "s", step: 5 },
} as const satisfies Record<BoundedPlannerKnobName, PlannerKnobBounds>;

/**
 * A value that isn't a non-negative number falls back to the default; one outside the bounds is clamped to
 * them. Takes `unknown` because config.json is hand-editable.
 */
export function effectivePlannerKnob(
  knobName: BoundedPlannerKnobName,
  configuredValue: unknown
): { value: number; correction: string | undefined } {
  const { defaultValue, min, max, unit } = PLANNER_KNOB_BOUNDS[knobName];
  if (typeof configuredValue !== "number" || !Number.isFinite(configuredValue) || configuredValue < 0) {
    const shown = typeof configuredValue === "string" ? JSON.stringify(configuredValue) : String(configuredValue);
    return {
      value: defaultValue,
      correction: `${shown} is not a non-negative number, using the default ${defaultValue} ${unit}`,
    };
  }
  if (configuredValue < min) {
    return {
      value: min,
      correction: `${configuredValue} ${unit} is below the ${min} ${unit} minimum, using the minimum`,
    };
  }
  if (configuredValue > max) {
    return {
      value: max,
      correction: `${configuredValue} ${unit} exceeds the ${max} ${unit} maximum, using the maximum`,
    };
  }
  return { value: configuredValue, correction: undefined };
}
