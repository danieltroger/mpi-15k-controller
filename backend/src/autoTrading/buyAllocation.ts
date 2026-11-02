/**
 * The planner's buy passes (called by generatePlan after sell consolidation). Buying costs far more
 * per kWh than selling earns (planner.ts's economics), so a buy is only accepted when the extra kWh it
 * brings in save at least min_buy_saving_sek_per_kwh each: first by pre-buying at the cheapest hours to
 * avert a projected unavoidable import, then — when allow_arbitrage_buying is on — by buying cheap
 * purely to re-sell at a later peak, trialled as buy/sell pairs. With a terminal value the pre-buy pass
 * buys in contiguous blocks instead, and also stocks up for after the horizon in one block at
 * terminal_value_min_saving_sek_per_kwh. All trial on the candidate schedule in place.
 */

import { overlapsVeto, simulate } from "./simulate.ts";
import { SLOT_MS } from "./slotDuration.ts";
import type { AllocationContext, SimResult } from "./planner.types.ts";

/**
 * Buy allocation, pass 1: pre-buying at cheap hours. Without a terminal value it averts projected
 * unavoidable imports, cheapest slots first (preBuyAgainstUnavoidableImport). With one (terminalValue.ts)
 * it averts the shortfall and then stocks up for after the horizon, in blocks (preBuyWithTerminalValue). Leaves each
 * accepted buy's power in context.buyW and returns the accepted slots with their simulation, and which
 * of them only stock up.
 */
export function preBuyAtCheapHours(
  context: AllocationContext,
  resultSoFar: SimResult,
  notes: string[]
): { result: SimResult; acceptedBuy: number[]; stockingBuySlots: Set<number> } {
  if (context.valuation.endEnergySekPerKwh > 0) return preBuyWithTerminalValue(context, resultSoFar, notes);
  return { ...preBuyAgainstUnavoidableImport(context, resultSoFar, notes), stockingBuySlots: new Set() };
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
 * Pre-buying without a terminal value: avert projected unavoidable imports, cheapest slots first, keeping
 * every buy that saves min_buy_saving_sek_per_kwh. importWh also counts what the accepted buys (and any
 * fixed buy window) draw, so after the first accepted buy the break can't fire and every candidate is
 * tried — which earns more than stopping once the shortfall is averted, so it stays that way.
 */
function preBuyAgainstUnavoidableImport(
  context: AllocationContext,
  resultSoFar: SimResult,
  notes: string[]
): { result: SimResult; acceptedBuy: number[] } {
  const { input, slots, sellW, buyW, valuation, feasibleVsBase } = context;
  const knobs = input.knobs;
  let current = resultSoFar;
  const acceptedBuy: number[] = [];
  if (current.importWh > 500 && knobs.max_buy_power_watts > 0) {
    notes.push(
      `Projected unavoidable import of ${(current.importWh / 1000).toFixed(1)} kWh — evaluating pre-buying at cheap hours`
    );
    for (const slotIndex of preBuyCandidates(context)) {
      if (sellW[slotIndex] > 0) continue;
      buyW[slotIndex] = knobs.max_buy_power_watts;
      const trial = simulate(input, slots, sellW, buyW, valuation);
      const gain = trial.revenueSek - current.revenueSek;
      const extraBoughtKwh = (trial.boughtWh - current.boughtWh) / 1000;
      if (feasibleVsBase(trial) && extraBoughtKwh > 0 && gain / extraBoughtKwh >= knobs.min_buy_saving_sek_per_kwh) {
        current = trial;
        acceptedBuy.push(slotIndex);
      } else {
        buyW[slotIndex] = 0;
      }
      if (current.importWh < 500) break;
    }
  }
  return { result: current, acceptedBuy };
}

/**
 * Pre-buying with a terminal value, in contiguous blocks (bestBuyBlock). A buy that adds stock "pays" through
 * the end-of-plan credit, so the cheapest-first loop above would accept a top-up in every quarter the house
 * drains, each its own heavy grid-charge window (heavy charge ends are the inverter's DC-idle latch risk).
 * Only the energy left at the end is credited, so one block where the battery has the most room reaches
 * about the same end SOC. First blocks that avert the shortfall (the import an empty battery forces) at
 * min_buy_saving_sek_per_kwh — they top the battery up as far as that margin pays, the energy left being
 * credited — then one stocking block for after the horizon at terminal_value_min_saving_sek_per_kwh; the
 * next plan run can add another.
 */
function preBuyWithTerminalValue(
  context: AllocationContext,
  resultSoFar: SimResult,
  notes: string[]
): { result: SimResult; acceptedBuy: number[]; stockingBuySlots: Set<number> } {
  const knobs = context.input.knobs;
  let current = resultSoFar;
  const acceptedBuy: number[] = [];
  if (knobs.max_buy_power_watts <= 0) return { result: current, acceptedBuy, stockingBuySlots: new Set() };
  if (current.shortfallImportWh > 500) {
    notes.push(
      `Projected unavoidable import of ${(current.shortfallImportWh / 1000).toFixed(1)} kWh — evaluating pre-buying at cheap hours`
    );
    while (current.shortfallImportWh > 500) {
      const shortfallBeforeWh = current.shortfallImportWh;
      const avertingBlock = bestBuyBlock(context, current, trial =>
        trial.shortfallImportWh < shortfallBeforeWh - 1 ? knobs.min_buy_saving_sek_per_kwh : undefined
      );
      if (!avertingBlock) break;
      current = avertingBlock.result;
      acceptedBuy.push(...avertingBlock.slotIndexes);
    }
  }
  const stockingBlock = bestBuyBlock(context, current, () => knobs.terminal_value_min_saving_sek_per_kwh);
  if (!stockingBlock) return { result: current, acceptedBuy, stockingBuySlots: new Set() };
  acceptedBuy.push(...stockingBlock.slotIndexes);
  notes.push(
    `Stocking up ~${((stockingBlock.result.boughtWh - current.boughtWh) / 1000).toFixed(1)} kWh in one block for after the horizon — end-of-plan energy is worth ${context.valuation.endEnergySekPerKwh.toFixed(2)} SEK/kWh`
  );
  return { result: stockingBlock.result, acceptedBuy, stockingBuySlots: new Set(stockingBlock.slotIndexes) };
}

/**
 * The contiguous block of free priced slots, bought at max_buy_power_watts and at least min_window_minutes
 * long, that adds the most value beyond a margin on every kWh it buys. marginFor gives that margin for a
 * block (SEK per kWh bought), or undefined when the block doesn't qualify. A block stops growing where the
 * battery would be full: longer would only hold a charge window open for nothing. Leaves the chosen block's
 * power in context.buyW; undefined when no block qualifies and pays.
 */
function bestBuyBlock(
  context: AllocationContext,
  resultSoFar: SimResult,
  marginFor: (trial: SimResult) => number | undefined
): { result: SimResult; slotIndexes: number[] } | undefined {
  const { input, slots, sellW, buyW, valuation, feasibleVsBase } = context;
  const knobs = input.knobs;
  const minimumSlots = Math.max(1, Math.ceil((knobs.min_window_minutes * 60_000) / SLOT_MS));
  const free = slots.map((slot, slotIndex) => slotFreeForBlockBuy(context, slotIndex));
  let best: { startIndex: number; length: number; result: SimResult; netGainSek: number } | undefined;
  for (let startIndex = 0; startIndex < slots.length; startIndex++) {
    let endIndex = startIndex;
    let previousBoughtWh = resultSoFar.boughtWh;
    for (; endIndex < slots.length && free[endIndex]; endIndex++) {
      buyW[endIndex] = knobs.max_buy_power_watts;
      const trial = simulate(input, slots, sellW, buyW, valuation);
      if (trial.boughtWh <= previousBoughtWh) break;
      previousBoughtWh = trial.boughtWh;
      const length = endIndex - startIndex + 1;
      const margin = length >= minimumSlots && feasibleVsBase(trial) ? marginFor(trial) : undefined;
      if (margin === undefined) continue;
      // The gain beyond the margin on every kWh: a block whose average clears the margin could still carry
      // quarters that don't, and those the cheapest-first loop would have turned down one by one
      const extraBoughtKwh = (trial.boughtWh - resultSoFar.boughtWh) / 1000;
      const netGainSek = trial.revenueSek - resultSoFar.revenueSek - margin * extraBoughtKwh;
      // Ties go to the later block: it leaves the battery fuller for longer after the horizon
      if (netGainSek > 0 && netGainSek >= (best?.netGainSek ?? 0)) {
        best = { startIndex, length, result: trial, netGainSek };
      }
    }
    for (let slotIndex = startIndex; slotIndex <= Math.min(endIndex, slots.length - 1); slotIndex++) {
      if (free[slotIndex]) buyW[slotIndex] = 0;
    }
  }
  if (!best) return undefined;
  const slotIndexes = Array.from({ length: best.length }, (_, offset) => best.startIndex + offset);
  for (const slotIndex of slotIndexes) buyW[slotIndex] = knobs.max_buy_power_watts;
  return { result: best.result, slotIndexes };
}

/** Pre-buy candidates, cheapest first: priced, not selling, outside fixed sells and buy vetoes */
function preBuyCandidates(context: AllocationContext): number[] {
  const { input, slots, sellW } = context;
  return slots
    .map((slot, slotIndex) => ({ slot, slotIndex }))
    .filter(
      ({ slot, slotIndex }) =>
        slot.spot !== undefined &&
        slot.fixedSellW === 0 &&
        sellW[slotIndex] === 0 &&
        !overlapsVeto(slot, input.buyVetoWindows)
    )
    .sort((cheaper, pricier) => cheaper.slot.spot! - pricier.slot.spot!)
    .map(({ slotIndex }) => slotIndex);
}

/** A pre-buy candidate (preBuyCandidates) that no buy, fixed or planned, uses yet: where a block may go */
function slotFreeForBlockBuy(context: AllocationContext, slotIndex: number): boolean {
  const { input, slots, sellW, buyW } = context;
  const slot = slots[slotIndex];
  return (
    slot.spot !== undefined &&
    slot.fixedSellW === 0 &&
    slot.fixedBuyW === 0 &&
    sellW[slotIndex] === 0 &&
    buyW[slotIndex] === 0 &&
    !overlapsVeto(slot, input.buyVetoWindows)
  );
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
