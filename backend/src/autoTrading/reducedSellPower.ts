/**
 * The greedy's fallback for a sell slot that would breach the reserve floor at full power (planner.ts):
 * sell the largest power that still fits. Without it a leftover budget smaller than a full-power quarter
 * skipped every good quarter and fell through to whatever cheaper slot happened to be small enough at full
 * power: on 2026-10-28 and 2026-10-29 that was the current slot with ~7 min left, sold at 1.62 and 1.49 SEK
 * while 2.2 SEK evening quarters were rejected.
 */

import { simulate } from "./simulate.ts";
import type { PlannerInput, SimResult, Slot } from "./planner.types.ts";

/** Reduced powers are whole multiples of this, so windows read as round numbers */
export const SELL_POWER_STEP_WATTS = 100;

/** What a power trial needs; sellW is the greedy's candidate schedule, mutated in place */
export type SellPowerSearch = {
  input: PlannerInput;
  slots: Slot[];
  sellW: number[];
  buyW: number[];
  tailSpot: number;
  feasible: (result: SimResult) => boolean;
};

export type FeasibleSellPower = { watts: number; result: SimResult };

/**
 * Binary search on simulate between min_sell_power_watts (rounded up to the step) and infeasibleWatts (known
 * to breach the floor). Feasibility falls as power rises (more export, a lower SOC in every later slot), so
 * the search ends on the largest feasible step: one simulation when even the minimum doesn't fit (the common
 * case once a budget is spent), at most 1 + ⌈log2(range / step)⌉ otherwise (9 for 1.5 → 15 kW). Every power
 * it returns was simulated feasible, so a corner where that isn't monotonic (the runtime cutoff stopping a
 * later window) can only cost a little power, never a floor breach.
 * Leaves sellW[slotIndex] at the power found, or 0 when none fits.
 */
export function largestFeasibleSellPower(
  search: SellPowerSearch,
  slotIndex: number,
  infeasibleWatts: number
): FeasibleSellPower | undefined {
  const minimumWatts =
    Math.ceil(search.input.knobs.min_sell_power_watts / SELL_POWER_STEP_WATTS) * SELL_POWER_STEP_WATTS;
  let best = minimumWatts < infeasibleWatts ? trySellPower(search, slotIndex, minimumWatts) : undefined;
  if (!best) {
    search.sellW[slotIndex] = 0;
    return undefined;
  }
  let tooMuchWatts = infeasibleWatts;
  while (tooMuchWatts - best.watts > SELL_POWER_STEP_WATTS) {
    const middleWatts = Math.round((best.watts + tooMuchWatts) / 2 / SELL_POWER_STEP_WATTS) * SELL_POWER_STEP_WATTS;
    const trial = trySellPower(search, slotIndex, middleWatts);
    if (trial) best = trial;
    else tooMuchWatts = middleWatts;
  }
  search.sellW[slotIndex] = best.watts;
  return best;
}

function trySellPower(search: SellPowerSearch, slotIndex: number, watts: number): FeasibleSellPower | undefined {
  search.sellW[slotIndex] = watts;
  const result = simulate(search.input, search.slots, search.sellW, search.buyW, search.tailSpot);
  return search.feasible(result) ? { watts, result } : undefined;
}
