/**
 * What the planner-family selftests (planner, simulate, reducedSellPower, plannerKnobBounds) share: a
 * midnight-aligned clock, 15-min price series, the scenarios' base knobs and a pass/fail tally. Not a
 * selftest itself; each selftest runs in its own process, so the tally is per file.
 */
import process from "process";
import { SLOT_MS } from "./planner.ts";
import type { PlannerKnobs, PriceSlot15 } from "./planner.types.ts";

export const H = 3600_000;

/** A midnight-aligned (UTC) "now" the scenarios count hours from */
export const t0 = Math.floor(Date.now() / (24 * H)) * 24 * H;

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
};

/** 15-min spot prices from t0 for the given number of hours */
export function mkPrices(hours: number, priceAtHour: (hour: number) => number): PriceSlot15[] {
  const prices: PriceSlot15[] = [];
  for (let startMs = t0; startMs < t0 + hours * H; startMs += SLOT_MS) {
    prices.push({ startMs, spot: priceAtHour((startMs - t0) / H) });
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
