/**
 * The planner's buy passes (called by generatePlan after sell consolidation). Buying costs far more
 * per kWh than selling earns (planner.ts's economics), so a buy is only accepted when the extra kWh it
 * brings in save at least min_buy_saving_sek_per_kwh each: first by pre-buying at the cheapest hours to
 * avert a projected unavoidable import, then — when allow_arbitrage_buying is on — by buying cheap
 * purely to re-sell at a later peak, trialled as buy/sell pairs. With a terminal value the pre-buy pass
 * buys in contiguous blocks instead, and also stocks up for after the horizon in one block at
 * terminal_value_min_saving_sek_per_kwh. All trial on the candidate schedule in place.
 */

import { GRID_CHARGE_UP_TO_SOC_FRACTION, overlapsVeto, simulate } from "./simulate.ts";
import { SLOT_MS } from "./slotDuration.ts";
import type { AllocationContext, SimResult, Slot } from "./planner.types.ts";

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
 * Simulations one pre-buy pass with a terminal value may spend on its block searches (its averting blocks
 * and its stocking block share them), as consolidation's 400 cap its moves: a guard, not a tunable. Unbounded,
 * the search grew every start until the battery was full, O(slots²) simulations, up to ~0.5 s per plan on the
 * dev VM; the pi Zero 2 W is several times slower and plans on the event loop the inverter comms share. At
 * 400 a plan averages 4 ms there (2 ms without the terminal value), worst ~30 ms; in the PR #82 fuzz 10×
 * the budget found about 0.05 SEK per plan more.
 */
const BLOCK_SEARCH_TRIALS = 400;
/**
 * At most about this many lengths are simulated per block start, so a low buy power takes coarser steps: every
 * quarter at 15 kW (a full fill is ~19), every hour at 3 kW. 12 lost more value in the fuzz than the budget does.
 */
const BLOCK_LENGTHS_PER_START = 24;

/** One pre-buy pass's block searches: the candidate schedule, and the simulations they have left */
type BlockSearch = { context: AllocationContext; trialsLeft: number };

/** A block's footprint rules: in slots, at least a written window long and at most what fills an empty battery */
type BlockShape = { minimumSlots: number; maximumSlots: number; lengthStep: number; free: boolean[] };

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
  const search: BlockSearch = { context, trialsLeft: BLOCK_SEARCH_TRIALS };
  if (current.shortfallImportWh > 500) {
    notes.push(
      `Projected unavoidable import of ${(current.shortfallImportWh / 1000).toFixed(1)} kWh — evaluating pre-buying at cheap hours`
    );
    while (current.shortfallImportWh > 500) {
      const shortfallBeforeWh = current.shortfallImportWh;
      const avertingBlock = bestBuyBlock(search, current, trial =>
        trial.shortfallImportWh < shortfallBeforeWh - 1 ? knobs.min_buy_saving_sek_per_kwh : undefined
      );
      if (!avertingBlock) break;
      current = avertingBlock.result;
      acceptedBuy.push(...avertingBlock.slotIndexes);
    }
  }
  const stockingBlock = bestBuyBlock(search, current, () => knobs.terminal_value_min_saving_sek_per_kwh);
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
 * block (SEK per kWh bought), or undefined when the block doesn't qualify. Within the search's simulation
 * budget: the most promising starts (cheapest first) are tried first, and the lengths tried per start are
 * capped (blockFromStart). Leaves the chosen block's power in context.buyW; undefined when no block
 * qualifies and pays.
 */
function bestBuyBlock(
  search: BlockSearch,
  resultSoFar: SimResult,
  marginFor: (trial: SimResult) => number | undefined
): { result: SimResult; slotIndexes: number[] } | undefined {
  const { input, slots, sellW, buyW, valuation } = search.context;
  const knobs = input.knobs;
  const slotHours = SLOT_MS / 3_600_000;
  // Longer than filling an empty battery at full buy power, a block can't buy any more
  const maximumSlots =
    Math.ceil(
      (GRID_CHARGE_UP_TO_SOC_FRACTION * input.capacityWh) /
        (knobs.max_buy_power_watts * knobs.charge_efficiency * slotHours)
    ) + 1;
  const shape: BlockShape = {
    minimumSlots: Math.max(1, Math.ceil((knobs.min_window_minutes * 60_000) / SLOT_MS)),
    maximumSlots,
    lengthStep: Math.max(1, Math.ceil(maximumSlots / BLOCK_LENGTHS_PER_START)),
    free: slots.map((slot, slotIndex) => slotFreeForBlockBuy(search.context, slotIndex)),
  };
  let best: { startIndex: number; length: number; result: SimResult; netGainSek: number } | undefined;
  for (const startIndex of blockStartsByPromise(slots, shape)) {
    if (search.trialsLeft <= 0) break;
    const candidate = blockFromStart(search, resultSoFar, marginFor, startIndex, shape);
    if (!candidate || candidate.netGainSek <= 0) continue;
    // Ties go to the later block: it leaves the battery fuller for longer after the horizon
    const better =
      !best ||
      candidate.netGainSek > best.netGainSek ||
      (candidate.netGainSek === best.netGainSek && startIndex > best.startIndex);
    if (better) best = { startIndex, ...candidate };
  }
  if (!best) return undefined;
  const { startIndex } = best;
  const length = lengthWithoutFullBatteryEnd(search.context, best.result, startIndex, best.length, shape);
  const slotIndexes = Array.from({ length }, (_, offset) => startIndex + offset);
  for (const slotIndex of slotIndexes) buyW[slotIndex] = knobs.max_buy_power_watts;
  // A trimmed quarter bought nothing, but it held the baseline feed off: simulate the block as it is written
  const result = length === best.length ? best.result : simulate(input, slots, sellW, buyW, valuation);
  return { result, slotIndexes };
}

/**
 * The block's length without the quarters at its end that start on a full battery. A coarse length step
 * (low buy power) can take some in; they'd buy nothing but hold a charge window open, and the window would
 * claim energy the projection doesn't count.
 */
function lengthWithoutFullBatteryEnd(
  context: AllocationContext,
  blockResult: SimResult,
  startIndex: number,
  length: number,
  shape: BlockShape
): number {
  const { input } = context;
  const fullWh = input.capacityWh * GRID_CHARGE_UP_TO_SOC_FRACTION;
  let trimmedLength = length;
  while (trimmedLength > shape.minimumSlots) {
    const lastIndex = startIndex + trimmedLength - 1;
    const socAtStartWh =
      lastIndex === 0 ? (input.socPercent / 100) * input.capacityWh : blockResult.socAfterSlot[lastIndex - 1];
    if (socAtStartWh < fullWh) break;
    trimmedLength--;
  }
  return trimmedLength;
}

/**
 * The best block from one start: grown from the minimum length in lengthStep steps (the shorter ones aren't
 * simulated, they'd never be written), and no further once the battery is full, the free run or the price feed
 * breaks, or the start doesn't qualify at its shortest (a block that doesn't avert the shortfall at its
 * shortest won't by growing). Leaves context.buyW as it found it.
 */
function blockFromStart(
  search: BlockSearch,
  resultSoFar: SimResult,
  marginFor: (trial: SimResult) => number | undefined,
  startIndex: number,
  shape: BlockShape
): { length: number; result: SimResult; netGainSek: number } | undefined {
  const { input, slots, sellW, buyW, valuation, feasibleVsBase } = search.context;
  const runSlots = contiguousFreeSlots(slots, shape, startIndex);
  let best: { length: number; result: SimResult; netGainSek: number } | undefined;
  let previousBoughtWh = resultSoFar.boughtWh;
  let setUpToIndex = startIndex - 1;
  for (const blockSlots of blockLengths(shape, runSlots)) {
    if (search.trialsLeft <= 0) break;
    for (; setUpToIndex < startIndex + blockSlots - 1; setUpToIndex++) {
      buyW[setUpToIndex + 1] = input.knobs.max_buy_power_watts;
    }
    search.trialsLeft--;
    const trial = simulate(input, slots, sellW, buyW, valuation);
    if (trial.boughtWh <= previousBoughtWh) break;
    previousBoughtWh = trial.boughtWh;
    const margin = feasibleVsBase(trial) ? marginFor(trial) : undefined;
    if (margin === undefined) {
      if (blockSlots === shape.minimumSlots) break;
      continue;
    }
    // The gain beyond the margin on every kWh: a block whose average clears the margin could still carry
    // quarters that don't, and those the cheapest-first loop would have turned down one by one
    const extraBoughtKwh = (trial.boughtWh - resultSoFar.boughtWh) / 1000;
    const netGainSek = trial.revenueSek - resultSoFar.revenueSek - margin * extraBoughtKwh;
    if (!best || netGainSek > best.netGainSek) best = { length: blockSlots, result: trial, netGainSek };
  }
  for (let slotIndex = startIndex; slotIndex <= setUpToIndex; slotIndex++) buyW[slotIndex] = 0;
  return best;
}

/** The lengths tried from one start: the minimum, then every lengthStep, and the free run's end */
function blockLengths(shape: BlockShape, runSlots: number): number[] {
  const lengths: number[] = [];
  for (let length = shape.minimumSlots; length < runSlots; length += shape.lengthStep) lengths.push(length);
  lengths.push(runSlots);
  return lengths;
}

/**
 * Block starts with room for a minimum-length block, most promising first: the cheapest mean spot over that
 * minimum length (the later start on a tie), so a budget that runs out has tried the cheap stretches
 */
function blockStartsByPromise(slots: Slot[], shape: BlockShape): number[] {
  const starts: { startIndex: number; meanSpot: number }[] = [];
  for (let startIndex = 0; startIndex < slots.length; startIndex++) {
    if (contiguousFreeSlots(slots, shape, startIndex) < shape.minimumSlots) continue;
    let spotSum = 0;
    for (let offset = 0; offset < shape.minimumSlots; offset++) spotSum += slots[startIndex + offset].spot!;
    starts.push({ startIndex, meanSpot: spotSum / shape.minimumSlots });
  }
  return starts
    .sort((cheaper, pricier) => cheaper.meanSpot - pricier.meanSpot || pricier.startIndex - cheaper.startIndex)
    .map(({ startIndex }) => startIndex);
}

/**
 * How many slots from startIndex a block may cover, up to shape.maximumSlots: free ones, back to back in time
 * (a gap in the price feed would split the block into two windows, and one could be too short to be written)
 */
function contiguousFreeSlots(slots: Slot[], shape: BlockShape, startIndex: number): number {
  let count = 0;
  for (let slotIndex = startIndex; slotIndex < slots.length && count < shape.maximumSlots; slotIndex++) {
    if (!shape.free[slotIndex]) break;
    if (slotIndex > startIndex && slots[slotIndex].startMs !== slots[slotIndex - 1].endMs) break;
    count++;
  }
  return count;
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
