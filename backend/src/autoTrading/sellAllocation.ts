/**
 * The planner's sell allocation up to consolidation (called by generatePlan): the greedy that accepts
 * 15-min sell slots from the highest spot price down while every accepted plan stays feasible, falling
 * back to the largest power that still fits where full power would overdraw (reducedSellPower.ts), and
 * the bridge pass that sells through short price valleys between the accepted windows instead of
 * restarting the feed-in ramp. Both trial on the candidate schedule in place; sellConsolidation.ts then
 * repairs the fragmentation the greedy's accept order left.
 */

import { simulate, slotTradableForSell } from "./simulate.ts";
import {
  joinedChainMinutes,
  largestFeasibleSellPower,
  SELL_POWER_STEP_WATTS,
  type SellPowerSearch,
} from "./reducedSellPower.ts";
import { SLOT_MS } from "./slotDuration.ts";
import type { AllocationContext, SimResult } from "./planner.types.ts";

/**
 * Greedy sell allocation, highest spot first, starting from the no-trade projection (base). Leaves
 * each accepted slot's power in context.sellW and returns the accepted slots with their simulation.
 */
export function allocateSellsGreedily(
  context: AllocationContext,
  base: SimResult
): { result: SimResult; acceptedSell: number[] } {
  const { input, slots, sellW, buyW, tailSpot, feasibleVsBase } = context;
  const knobs = input.knobs;
  const sellCandidates = slots
    .map((slot, slotIndex) => ({ slot, slotIndex }))
    .filter(
      ({ slot }) => slotTradableForSell(slot, input.sellVetoWindows) && slot.spot! >= knobs.min_sell_spot_sek_per_kwh
    )
    .sort((a, b) => b.slot.spot! - a.slot.spot!);

  let current = base;
  const acceptedSell: number[] = [];
  const powerSearch: SellPowerSearch = { input, slots, sellW, buyW, tailSpot, feasible: feasibleVsBase };
  // The largest fitting power of the last reduced slot rejected for too little gain. Its leftover
  // stays where it was, and the candidates after it are no pricier: one that can't take more power
  // than that can't gain more either, so its search starts just above (one simulation to rule it
  // out). Without this, a leftover just too small to clear min_gain_sek_per_slot sent every
  // remaining candidate through a full search.
  let gainRejectedWatts: number | undefined;
  for (const { slotIndex } of sellCandidates) {
    sellW[slotIndex] = knobs.max_sell_power_watts;
    let trial = simulate(input, slots, sellW, buyW, tailSpot);
    let reducedWatts: number | undefined;
    if (!feasibleVsBase(trial)) {
      // Full power overdraws the remaining budget: sell what still fits here, so a leftover lands in
      // the best remaining quarter rather than in whichever cheaper slot is small enough at full
      // power. Not where the chain would stay shorter than min_window_minutes: the merge would drop
      // it and the budget with it, so the leftover waits for a slot next to a run (or for
      // consolidation's edge extension).
      if (joinedChainMinutes(slots, sellW, slotIndex) < knobs.min_window_minutes) {
        sellW[slotIndex] = 0;
        continue;
      }
      const reduced = largestFeasibleSellPower(
        powerSearch,
        [slotIndex],
        gainRejectedWatts !== undefined ? gainRejectedWatts + SELL_POWER_STEP_WATTS : knobs.min_sell_power_watts,
        knobs.max_sell_power_watts
      );
      if (!reduced) continue;
      trial = reduced.result;
      reducedWatts = reduced.watts;
    }
    const gain = trial.revenueSek - current.revenueSek;
    if (gain >= knobs.min_gain_sek_per_slot) {
      current = trial;
      acceptedSell.push(slotIndex);
      gainRejectedWatts = undefined;
    } else {
      sellW[slotIndex] = 0;
      if (reducedWatts !== undefined) gainRejectedWatts = reducedWatts;
    }
  }
  return { result: current, acceptedSell };
}

/**
 * Bridge short price valleys between accepted windows: every feed stop/start restarts the
 * slow feed-in ramp (which the simulation prices in), so selling through a shallow dip is
 * usually better than pausing — and nobody wants a schedule with a 30-min hole in it.
 * Accept a bounded revenue loss per bridged slot; the sim decides using ramp + prices.
 * Appends the bridged slots to acceptedSell and returns the simulation with them.
 */
export function bridgeSellValleys(
  context: AllocationContext,
  resultSoFar: SimResult,
  acceptedSell: number[]
): SimResult {
  const { input, slots, sellW, buyW, tailSpot, feasibleVsBase } = context;
  const knobs = input.knobs;
  let current = resultSoFar;
  const maxGapSlots = 3;
  const maxSmoothingLossSekPerSlot = 1;
  for (let pass = 0, changed = true; pass < 4 && changed; pass++) {
    changed = false;
    const acceptedSorted = [...new Set(acceptedSell)].sort((a, b) => a - b);
    for (let idx = 0; idx + 1 < acceptedSorted.length; idx++) {
      const before = acceptedSorted[idx];
      const after = acceptedSorted[idx + 1];
      const gapSlots = after - before - 1;
      if (gapSlots < 1 || gapSlots > maxGapSlots) continue;
      if (slots[after].startMs - slots[before].endMs !== gapSlots * SLOT_MS) continue;
      const fillable: number[] = [];
      for (let j = before + 1; j < after; j++) {
        if (sellW[j] > 0 || !slotTradableForSell(slots[j], input.sellVetoWindows)) {
          fillable.length = 0;
          break;
        }
        fillable.push(j);
      }
      if (fillable.length !== gapSlots) continue;
      for (const j of fillable) sellW[j] = knobs.max_sell_power_watts;
      const trial = simulate(input, slots, sellW, buyW, tailSpot);
      if (feasibleVsBase(trial) && trial.revenueSek - current.revenueSek >= -maxSmoothingLossSekPerSlot * gapSlots) {
        current = trial;
        acceptedSell.push(...fillable);
        changed = true;
      } else {
        for (const j of fillable) sellW[j] = 0;
      }
    }
  }
  return current;
}
