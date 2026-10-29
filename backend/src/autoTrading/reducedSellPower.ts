/**
 * The greedy's fallback for a sell slot that would breach the reserve floor at full power (sellAllocation.ts):
 * sell the largest power that still fits. Without it a leftover budget smaller than a full-power quarter
 * skipped every good quarter and fell through to whatever cheaper slot happened to be small enough at full
 * power: on 2026-10-28 and 2026-10-29 that was the current slot with ~7 min left, sold at 1.62 and 1.49 SEK
 * while 2.2 SEK evening quarters were rejected. Consolidation (sellConsolidation.ts) uses the same search for
 * its pure adds and for flattening a power staircase.
 */

import { simulate } from "./simulate.ts";
import type { PlannerInput, SimResult, Slot } from "./planner.types.ts";

/** Reduced powers are whole multiples of this, so windows read as round numbers */
export const SELL_POWER_STEP_WATTS = 100;

/** What a power trial needs; sellW is the candidate schedule, mutated in place */
export type SellPowerSearch = {
  input: PlannerInput;
  slots: Slot[];
  sellW: number[];
  buyW: number[];
  tailSpot: number;
  feasible: (result: SimResult) => boolean;
  /** Consolidation's simulate-call budget, charged one per trial when present */
  trialsLeft?: number;
};

export type FeasibleSellPower = { watts: number; result: SimResult };

/**
 * Binary search on simulate for the largest power, set on every one of slotIndexes, between minimumWatts
 * (rounded up to the step) and infeasibleWatts (known to breach the floor). The greedy searches one slot
 * from min_sell_power_watts; equalizeChainPower a chain's body from its lowest power. Feasibility falls as
 * power rises (more export, a lower SOC in every later slot), so the search ends on the largest feasible
 * step: one simulation when even the minimum doesn't fit (the common case once a budget is spent), at most
 * 1 + ⌈log2(range / step)⌉ otherwise (9 for 1.5 → 15 kW). Every power it returns was simulated feasible,
 * so a corner where that isn't monotonic (the runtime cutoff stopping a later window) can only cost a
 * little power, never a floor breach.
 * Leaves the slots at the power found, or at 0 when none fits.
 */
export function largestFeasibleSellPower(
  search: SellPowerSearch,
  slotIndexes: number[],
  minimumWatts: number,
  infeasibleWatts: number
): FeasibleSellPower | undefined {
  const lowestTriedWatts = Math.ceil(minimumWatts / SELL_POWER_STEP_WATTS) * SELL_POWER_STEP_WATTS;
  let best = lowestTriedWatts < infeasibleWatts ? trySellPower(search, slotIndexes, lowestTriedWatts) : undefined;
  if (!best) {
    for (const slotIndex of slotIndexes) search.sellW[slotIndex] = 0;
    return undefined;
  }
  let tooMuchWatts = infeasibleWatts;
  while (tooMuchWatts - best.watts > SELL_POWER_STEP_WATTS) {
    const middleWatts = Math.round((best.watts + tooMuchWatts) / 2 / SELL_POWER_STEP_WATTS) * SELL_POWER_STEP_WATTS;
    const trial = trySellPower(search, slotIndexes, middleWatts);
    if (trial) best = trial;
    else tooMuchWatts = middleWatts;
  }
  for (const slotIndex of slotIndexes) search.sellW[slotIndex] = best.watts;
  return best;
}

/**
 * How long the chain of accepted sell slots through slotIndex would last, slotIndex included —
 * the length mergeAcceptedSlots judges against min_window_minutes (whole slots, even a partial
 * current one).
 */
export function joinedChainMinutes(slots: Slot[], sellW: number[], slotIndex: number): number {
  let firstIndex = slotIndex;
  while (firstIndex > 0 && sellW[firstIndex - 1] > 0 && slots[firstIndex - 1].endMs === slots[firstIndex].startMs) {
    firstIndex--;
  }
  let lastIndex = slotIndex;
  while (
    lastIndex + 1 < slots.length &&
    sellW[lastIndex + 1] > 0 &&
    slots[lastIndex + 1].startMs === slots[lastIndex].endMs
  ) {
    lastIndex++;
  }
  return (slots[lastIndex].endMs - slots[firstIndex].startMs) / 60_000;
}

function trySellPower(search: SellPowerSearch, slotIndexes: number[], watts: number): FeasibleSellPower | undefined {
  for (const slotIndex of slotIndexes) search.sellW[slotIndex] = watts;
  if (search.trialsLeft !== undefined) search.trialsLeft--;
  const result = simulate(search.input, search.slots, search.sellW, search.buyW, search.tailSpot);
  return search.feasible(result) ? { watts, result } : undefined;
}
