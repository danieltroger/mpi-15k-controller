/**
 * The planner's buy passes (called by generatePlan after sell consolidation). Buying costs far more
 * per kWh than selling earns (planner.ts's economics), so a buy is only accepted when the extra kWh it
 * brings in save at least min_buy_saving_sek_per_kwh each: first by pre-buying at the cheapest hours to
 * avert a projected unavoidable import or, with a terminal value, to stock up for after the horizon,
 * then — when allow_arbitrage_buying is on — by buying cheap purely to re-sell at a later peak,
 * trialled as buy/sell pairs. Both trial on the candidate schedule in place.
 */

import { overlapsVeto, simulate } from "./simulate.ts";
import { mergeAcceptedSlots } from "./planWindows.ts";
import type { AllocationContext, SimResult } from "./planner.types.ts";

/**
 * Buy allocation, pass 1, cheapest slots first: avert projected unavoidable imports and, when the plan
 * has a terminal value (terminalValue.ts), stock up for after the horizon — a kWh kept past the plan
 * saves a later import even when the priced horizon shows none, so the pass then keeps going after the
 * import is averted. Leaves each accepted buy's power in context.buyW and returns the accepted slots
 * with their simulation, and which of them were bought with no import left to avert (stocking up).
 */
export function preBuyAtCheapHours(
  context: AllocationContext,
  resultSoFar: SimResult,
  notes: string[]
): { result: SimResult; acceptedBuy: number[]; stockingBuySlots: Set<number> } {
  const { input, slots, sellW, buyW, valuation, feasibleVsBase } = context;
  const knobs = input.knobs;
  let current = resultSoFar;
  const acceptedBuy: number[] = [];
  const stockingBuySlots = new Set<number>();
  const stockingUp = valuation.endEnergySekPerKwh > 0;
  if (!(current.importWh > 500 || stockingUp) || knobs.max_buy_power_watts <= 0) {
    return { result: current, acceptedBuy, stockingBuySlots };
  }
  if (current.importWh > 500) {
    notes.push(
      `Projected unavoidable import of ${(current.importWh / 1000).toFixed(1)} kWh — evaluating pre-buying at cheap hours`
    );
  }
  const buyCandidates = slots
    .map((slot, slotIndex) => ({ slot, slotIndex }))
    .filter(
      ({ slot, slotIndex }) =>
        slot.spot !== undefined &&
        slot.fixedSellW === 0 &&
        sellW[slotIndex] === 0 &&
        !overlapsVeto(slot, input.buyVetoWindows)
    )
    .sort((cheaper, pricier) => cheaper.slot.spot! - pricier.slot.spot!);
  for (const { slotIndex } of buyCandidates) {
    if (sellW[slotIndex] > 0) continue;
    // importWh also counts what the accepted buys draw, so the import left to avert is the shortfall
    const boughtToStockUp = stockingUp && current.shortfallImportWh <= 500;
    buyW[slotIndex] = knobs.max_buy_power_watts;
    const trial = simulate(input, slots, sellW, buyW, valuation);
    const gain = trial.revenueSek - current.revenueSek;
    const extraBoughtKwh = (trial.boughtWh - current.boughtWh) / 1000;
    if (feasibleVsBase(trial) && extraBoughtKwh > 0 && gain / extraBoughtKwh >= knobs.min_buy_saving_sek_per_kwh) {
      current = trial;
      acceptedBuy.push(slotIndex);
      if (boughtToStockUp) stockingBuySlots.add(slotIndex);
    } else {
      buyW[slotIndex] = 0;
    }
    // Stocking up has no import to run out of: it tries every candidate, keeping each one that pays
    if (current.shortfallImportWh < 500 && !stockingUp) break;
  }
  if (dropUnwritableStockingSlots(context, acceptedBuy, stockingBuySlots)) {
    current = simulate(input, slots, sellW, buyW, valuation);
  }
  const stockedKwh = [...stockingBuySlots].reduce(
    (sum, slotIndex) => sum + (buyW[slotIndex] * slots[slotIndex].durationH) / 1000,
    0
  );
  if (stockedKwh > 0) {
    notes.push(
      `Stocking up ~${stockedKwh.toFixed(1)} kWh at cheap hours for after the horizon — end-of-plan energy is worth ${valuation.endEnergySekPerKwh.toFixed(2)} SEK/kWh`
    );
  }
  return { result: current, acceptedBuy, stockingBuySlots };
}

/**
 * Buy allocation, pass 2: arbitrage. Buy cheap purely to re-sell expensive when the spread
 * beats fees + VAT + round-trip losses + margin. Buys and sells only pay off together (bought
 * energy has no value without a later sell window), so they are trialled as pairs.
 * Appends each accepted pair to acceptedBuy and acceptedSell (their powers stay in context.buyW and
 * context.sellW) and returns the simulation with them, plus which buy slots are arbitrage ones.
 */
export function allocateArbitragePairs(
  context: AllocationContext,
  resultSoFar: SimResult,
  acceptedSell: number[],
  acceptedBuy: number[],
  notes: string[]
): { result: SimResult; arbitrageBuySlots: Set<number> } {
  const { input, slots, sellW, buyW, valuation, feasibleVsBase } = context;
  const knobs = input.knobs;
  let current = resultSoFar;
  const arbitrageBuySlots = new Set<number>();
  if (knobs.allow_arbitrage_buying && knobs.max_buy_power_watts > 0) {
    const roundTrip = knobs.charge_efficiency * knobs.discharge_efficiency;
    const buyPool = slots
      .map((slot, slotIndex) => ({ slot, slotIndex }))
      .filter(
        ({ slot, slotIndex }) =>
          slotTradableForArbitrage(context, slotIndex) && !overlapsVeto(slot, input.buyVetoWindows)
      )
      .sort((cheaper, pricier) => cheaper.slot.spot! - pricier.slot.spot!);
    // A sold slot moves more energy out than one bought slot puts in (after losses), so a
    // 1:1 pairing is net-battery-negative and would always fail under a binding reserve floor.
    // Buy enough slots per sell slot to keep the pair battery-neutral or better.
    const buySlotKwh = (knobs.max_buy_power_watts * 0.25) / 1000;
    const sellSlotKwh = (Math.min(knobs.max_sell_power_watts, knobs.inverter_max_ac_output_watts) * 0.25) / 1000;
    const buysPerSell = Math.max(1, Math.ceil(sellSlotKwh / (buySlotKwh * roundTrip)));
    let misses = 0;
    let pairs = 0;
    while (pairs < 60 && misses < 4) {
      const buyGroup: number[] = [];
      for (const { slotIndex } of buyPool) {
        if (slotTradableForArbitrage(context, slotIndex) && !buyGroup.includes(slotIndex)) buyGroup.push(slotIndex);
        if (buyGroup.length === buysPerSell) break;
      }
      if (buyGroup.length < buysPerSell) break;
      const lastBuyStart = Math.max(...buyGroup.map(slotIndex => slots[slotIndex].startMs));
      const sellPool = slots
        .map((slot, slotIndex) => ({ slot, slotIndex }))
        .filter(
          ({ slot, slotIndex }) =>
            slotTradableForArbitrage(context, slotIndex) &&
            slot.startMs > lastBuyStart &&
            slot.spot! >= knobs.min_sell_spot_sek_per_kwh &&
            !overlapsVeto(slot, input.sellVetoWindows)
        )
        .sort((pricier, cheaper) => cheaper.slot.spot! - pricier.slot.spot!);
      if (!sellPool.length) break;
      // Even the best possible pairing must clear the margin on prices alone, else nothing can
      const avgBuySpot = buyGroup.reduce((sum, slotIndex) => sum + slots[slotIndex].spot!, 0) / buyGroup.length;
      const bestPossible =
        (sellPool[0].slot.spot! + knobs.sell_bonus_sek_per_kwh) * roundTrip -
        (avgBuySpot + knobs.buy_surcharges_sek_per_kwh) * knobs.vat_multiplier;
      if (bestPossible < knobs.min_buy_saving_sek_per_kwh) break;
      let matched = false;
      for (const { slotIndex: sellIndex } of sellPool.slice(0, 3)) {
        for (const buyIndex of buyGroup) buyW[buyIndex] = knobs.max_buy_power_watts;
        sellW[sellIndex] = knobs.max_sell_power_watts;
        const trial = simulate(input, slots, sellW, buyW, valuation);
        const gain = trial.revenueSek - current.revenueSek;
        const extraBoughtKwh = (trial.boughtWh - current.boughtWh) / 1000;
        if (
          feasibleVsBase(trial) &&
          extraBoughtKwh > 0.1 &&
          gain / extraBoughtKwh >= knobs.min_buy_saving_sek_per_kwh
        ) {
          current = trial;
          for (const buyIndex of buyGroup) {
            acceptedBuy.push(buyIndex);
            arbitrageBuySlots.add(buyIndex);
          }
          acceptedSell.push(sellIndex);
          matched = true;
          pairs++;
          break;
        }
        for (const buyIndex of buyGroup) buyW[buyIndex] = 0;
        sellW[sellIndex] = 0;
      }
      if (matched) {
        misses = 0;
      } else {
        misses++;
        // These cheapest buys couldn't pair profitably — drop the cheapest one and retry with the next mix
        const dropIndex = buyPool.findIndex(({ slotIndex }) => slotIndex === buyGroup[0]);
        if (dropIndex >= 0) buyPool.splice(dropIndex, 1);
        else break;
      }
    }
    if (pairs) {
      notes.push(
        `Arbitrage: ${pairs} buy/sell slot pair(s) accepted — spread beats fees + losses + ${knobs.min_buy_saving_sek_per_kwh} SEK/kWh margin`
      );
    }
  }
  return { result: current, arbitrageBuySlots };
}

/**
 * Stocking up tops the battery up again each time the house has drained a quarter's worth, in single
 * quarters. Ones that don't join a run of min_window_minutes are never written (mergeAcceptedSlots drops
 * them), so they leave the candidate schedule too: the projection mustn't count energy no window buys.
 * Returns whether any was dropped (the caller re-simulates).
 */
function dropUnwritableStockingSlots(
  context: AllocationContext,
  acceptedBuy: number[],
  stockingBuySlots: Set<number>
): boolean {
  const { slots, buyW, input } = context;
  if (!stockingBuySlots.size) return false;
  const { windows } = mergeAcceptedSlots(slots, acceptedBuy, buyW, "buy", input.knobs.min_window_minutes);
  const writtenSlots = new Set(windows.flatMap(window => window.slotIndexes));
  const unwritable = [...stockingBuySlots].filter(slotIndex => !writtenSlots.has(slotIndex));
  for (const slotIndex of unwritable) {
    buyW[slotIndex] = 0;
    stockingBuySlots.delete(slotIndex);
    acceptedBuy.splice(acceptedBuy.indexOf(slotIndex), 1);
  }
  return unwritable.length > 0;
}

/** A priced slot that is still free: no sell or buy accepted there yet and no fixed window in it */
function slotTradableForArbitrage(context: AllocationContext, slotIndex: number): boolean {
  const { slots, sellW, buyW } = context;
  return (
    slots[slotIndex].spot !== undefined &&
    sellW[slotIndex] === 0 &&
    buyW[slotIndex] === 0 &&
    slots[slotIndex].fixedSellW === 0 &&
    slots[slotIndex].fixedBuyW === 0
  );
}
