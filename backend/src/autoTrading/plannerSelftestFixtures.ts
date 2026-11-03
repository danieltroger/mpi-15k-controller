/**
 * What the planner-family selftests (planner, simulate, reducedSellPower, plannerKnobBounds) share: a
 * midnight-aligned clock, 15-min price series, the scenarios' base knobs, the terminal value switched on
 * or out of season, and a pass/fail tally. Not a selftest itself; each selftest runs in its own process,
 * so the tally is per file.
 */
import process from "process";
import { SLOT_MS } from "./planner.ts";
import { stockholmMonth } from "./terminalValue.ts";
import type { PlannerInput, PlannerKnobs, PriceSlot15 } from "./planner.types.ts";

export const HOUR_MS = 3600_000;

/** Midnight (UTC) of today: the "day" the scenarios count their hours from */
export const testDayStartMs = Math.floor(Date.now() / (24 * HOUR_MS)) * 24 * HOUR_MS;

export const baseKnobs: PlannerKnobs = {
  max_sell_power_watts: 15000,
  min_sell_power_watts: 1500,
  inverter_max_ac_output_watts: 15000,
  max_buy_power_watts: 10000,
  planner_soc_floor_percent: 20,
  runtime_soc_floor_percent: 15,
  emergency_soc_floor_percent: 3,
  extra_reserve_kwh: 0,
  min_sell_spot_sek_per_kwh: 0.08,
  min_gain_sek_per_slot: 0.25,
  min_window_minutes: 30,
  charge_efficiency: 0.95,
  discharge_efficiency: 0.93,
  buy_surcharges_sek_per_kwh: 1.186,
  vat_multiplier: 1.25,
  sell_bonus_sek_per_kwh: 0.092,
  min_buy_saving_sek_per_kwh: 0.3,
  baseline_feed_watts: 350,
  // The early scenarios predate ramp modeling, arbitrage, the sunny floor and the fragmentation
  // tolerance — keep them isolated (sunny floor == planner floor disables the relaxation)
  sell_ramp_minutes: 0,
  allow_arbitrage_buying: false,
  planner_soc_floor_sunny_percent: 20,
  fragmentation_tolerance_sek_per_window: 0,
  // Off, like the config default: end-of-plan energy is worth nothing (terminalValue.ts)
  terminal_value_mode: "off",
  terminal_value_scale: 0.9,
  terminal_value_trailing_days: 7,
  terminal_value_months: "10,11,12,1,2,3",
  terminal_value_min_saving_sek_per_kwh: 0.1,
  // Read by the "forecast" expected spot only, never by the planner
  terminal_value_forecast_max_deviation_sek: 1,
  terminal_value_forecast_max_age_hours: 6,
  terminal_value_forecast_wait_seconds: 30,
};

/** Every month: a terminal-value scenario is in season whatever day the selftest runs on */
export const EVERY_MONTH = "1,2,3,4,5,6,7,8,9,10,11,12";

/** The input with the terminal value on (the trailing source) at the given expected spot */
export function withTerminalValue(input: PlannerInput, expectedSpot: number, months = EVERY_MONTH): PlannerInput {
  return {
    ...input,
    expectedSpot: { expectedSpot, source: "trailing", detail: "7-day mean spot" },
    knobs: { ...input.knobs, terminal_value_mode: "trailing", terminal_value_months: months },
  };
}

/** terminal_value_months without the month (Swedish time) ms falls in: on, but out of season */
export function everyMonthExcept(ms: number): string {
  const excluded = stockholmMonth(ms);
  return EVERY_MONTH.split(",")
    .filter(month => Number(month) !== excluded)
    .join(",");
}

/** 15-min spot prices from testDayStartMs for the given number of hours */
export function mkPrices(hours: number, priceAtHour: (hour: number) => number): PriceSlot15[] {
  const prices: PriceSlot15[] = [];
  for (let startMs = testDayStartMs; startMs < testDayStartMs + hours * HOUR_MS; startMs += SLOT_MS) {
    prices.push({ startMs, spot: priceAtHour((startMs - testDayStartMs) / HOUR_MS) });
  }
  return prices;
}

const failedChecks: string[] = [];

export function check(name: string, passed: boolean, detail = "") {
  console.log(`${passed ? "PASS" : "FAIL"}: ${name} ${detail}`);
  if (!passed) failedChecks.push(name);
}

/** Prints the tally and exits non-zero when anything failed */
export function finishSelftest(): never {
  console.log(
    failedChecks.length ? `\n${failedChecks.length} FAILURES: ${failedChecks.join(", ")}` : "\nAll scenarios passed"
  );
  process.exit(failedChecks.length ? 1 : 0);
}
