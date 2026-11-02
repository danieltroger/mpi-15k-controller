/**
 * Pre-buying with a terminal value (called by buyAllocation.ts's preBuyAtCheapHours), in contiguous blocks:
 * blocks that avert the projected shortfall, then one stocking block for after the horizon. A block search
 * (bestBuyBlock) tries the most promising starts first within a budget of simulations, so a plan stays within
 * a few milliseconds of one without the terminal value.
 */

import { GRID_CHARGE_UP_TO_SOC_FRACTION, overlapsVeto, simulate } from "./simulate.ts";
import { SLOT_MS } from "./slotDuration.ts";
import type { AllocationContext, PreBuyResult, SimResult, Slot } from "./planner.types.ts";

/**
 * Pre-buying with a terminal value, in contiguous blocks (bestBuyBlock). A buy that adds stock "pays" through
 * the end-of-plan credit, so the cheapest-first loop (buyAllocation.ts's preBuyAgainstUnavoidableImport) would
 * accept a top-up in every quarter the house drains, each its own heavy grid-charge window (heavy charge ends
 * are the inverter's DC-idle latch risk).
 * Only the energy left at the end is credited, so one block where the battery has the most room reaches
 * about the same end SOC. First blocks that avert the shortfall (the import an empty battery forces) at
 * min_buy_saving_sek_per_kwh — they top the battery up as far as that margin pays, the energy left being
 * credited — then one stocking block for after the horizon at terminal_value_min_saving_sek_per_kwh; the
 * next plan run can add another.
 */
export function preBuyWithTerminalValue(
  context: AllocationContext,
  resultSoFar: SimResult,
  notes: string[]
): PreBuyResult {
  const knobs = context.input.knobs;
  let current = resultSoFar;
  const acceptedBuy: number[] = [];
  if (knobs.max_buy_power_watts <= 0) {
    return { result: current, acceptedBuy, stockingBuySlots: new Set(), stockedKwh: 0 };
  }
  const pass = { trialsLeft: PRE_BUY_PASS_TRIALS };
  if (current.shortfallImportWh > 500) {
    notes.push(
      `Projected unavoidable import of ${(current.shortfallImportWh / 1000).toFixed(1)} kWh — evaluating pre-buying at cheap hours`
    );
    while (current.shortfallImportWh > 500) {
      const shortfallBeforeWh = current.shortfallImportWh;
      const avertingBlock = searchBuyBlock(context, pass, current, trial =>
        trial.shortfallImportWh < shortfallBeforeWh - 1 ? knobs.min_buy_saving_sek_per_kwh : undefined
      );
      if (!avertingBlock) break;
      current = avertingBlock.result;
      acceptedBuy.push(...avertingBlock.slotIndexes);
    }
  }
  const stockingBlock = searchBuyBlock(context, pass, current, () => knobs.terminal_value_min_saving_sek_per_kwh);
  if (!stockingBlock) return { result: current, acceptedBuy, stockingBuySlots: new Set(), stockedKwh: 0 };
  acceptedBuy.push(...stockingBlock.slotIndexes);
  return {
    result: stockingBlock.result,
    acceptedBuy,
    stockingBuySlots: new Set(stockingBlock.slotIndexes),
    stockedKwh: (stockingBlock.result.boughtWh - current.boughtWh) / 1000,
  };
}

/**
 * Simulations one block search (bestBuyBlock) may spend, as consolidation's 400 cap its moves: a guard, not a
 * tunable. Unbounded, the search grew every start until the battery was full, O(slots²) simulations, up to
 * ~0.5 s per plan on the dev VM; the pi Zero 2 W is several times slower and plans on the event loop the
 * inverter comms share. Per search, not per pass: shared, the first averting block of a multi-day shortfall
 * used it up and the later ones were never searched (17 SEK per plan lost on deep-winter inputs in the PR #82
 * fuzz, against 0.15 SEK per search).
 */
const BLOCK_SEARCH_TRIALS = 400;
/**
 * Simulations all block searches of one pre-buy pass may spend together: a sanity cap for a plan with many
 * separate shortfalls (each averting block is a search of its own), so no plan runs unbounded on the pi. On
 * the PR #82 deep-winter inputs 12 searches' worth came within 0.03 SEK per plan of no cap, at ≤ ~50 ms on
 * the dev VM; 6 cost 0.46 SEK per plan.
 */
const PRE_BUY_PASS_TRIALS = 12 * BLOCK_SEARCH_TRIALS;
/**
 * At most about this many lengths are simulated per block start, so a low buy power takes coarser steps: every
 * quarter at 15 kW (a full fill is ~19), every hour at 3 kW. 12 lost more value in the fuzz than the budget does.
 */
const BLOCK_LENGTHS_PER_START = 24;

/** One block search: the candidate schedule, and the simulations it has left */
type BlockSearch = { context: AllocationContext; trialsLeft: number };

/** A block's footprint rules: in slots, at least a written window long and at most what fills an empty battery */
type BlockShape = { minimumSlots: number; maximumSlots: number; lengthStep: number; free: boolean[] };

/** bestBuyBlock with a budget of its own, drawn from what the pre-buy pass has left */
function searchBuyBlock(
  context: AllocationContext,
  pass: { trialsLeft: number },
  resultSoFar: SimResult,
  marginFor: (trial: SimResult) => number | undefined
): { result: SimResult; slotIndexes: number[] } | undefined {
  const budget = Math.min(BLOCK_SEARCH_TRIALS, pass.trialsLeft);
  if (budget <= 0) return undefined;
  const search: BlockSearch = { context, trialsLeft: budget };
  const block = bestBuyBlock(search, resultSoFar, marginFor);
  pass.trialsLeft -= budget - search.trialsLeft;
  return block;
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

/** A pre-buy candidate (as buyAllocation.ts's preBuyCandidates) that no buy, fixed or planned, uses yet: where a block may go */
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
