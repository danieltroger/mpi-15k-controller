/**
 * Pure day-ahead trading planner. No IO, no reading of the clock — everything comes in via PlannerInput,
 * so it can be simulated/tested standalone.
 *
 * Economics (E.ON, SE3, 2026): buying costs ≈ (spot + ~1.19 SEK surcharges) × 1.25 VAT ≈ 1.25×spot + 1.48 SEK/kWh,
 * selling earns ≈ spot + ~0.09 SEK/kWh. Buying is therefore only scheduled when it beats those numbers:
 * to avert an even more expensive unavoidable import (battery empty → house pulls from grid), or as
 * arbitrage when a later sell clears the full fee + round-trip-loss + margin stack (buyAllocation.ts).
 *
 * Strategy: simulate battery SOC over the price horizon (+ a constraint tail covering the following night)
 * using solar + consumption forecasts (simulate.ts), then greedily allocate 15-min sell slots from the
 * highest spot price down (sellAllocation.ts), keeping every accepted plan feasible (SOC never below the
 * planner floor + user reserve). A slot that full power would overdraw gets the largest power that still
 * fits (down to min_sell_power_watts, reducedSellPower.ts), so the last fraction of a budget goes to the
 * best remaining quarter that can still make a window of min_window_minutes. Selling energy the battery
 * couldn't have absorbed anyway (would have auto-exported when full) is naturally handled by the
 * simulation's revenue accounting.
 *
 * Fragmented schedules are allowed when they genuinely price better (a stop/start costs nothing but the
 * modeled ramp), but a consolidation pass (sellConsolidation.ts) repairs fragmentation the greedy's
 * accept order created for no gain, and sells budget its moves free up as reduced-power window
 * extensions. The reserve floor relaxes to planner_soc_floor_sunny_percent in slots where forecast PV
 * covers the house. The accepted slots are finally merged into schedule windows (planWindows.ts).
 *
 * Energy left in the battery when the simulation ends is worth nothing, unless terminal_value_mode values
 * it at the import it avoids later (terminalValue.ts): then selling competes with keeping, buying goes in
 * blocks and can stock up for after the horizon, the sells get a second pass once the buys have filled the
 * battery, and the unpriced tail is priced at the expected spot where that is higher. With hold_enabled it
 * finally holds (holdAllocation.ts): in cheap dark quarters no trade took, the house runs from the grid
 * through a trickle buy window while the battery keeps its energy.
 */

import { simulate } from "./simulate.ts";
import { runningFeedAtNow, sellRampWattsPerMinute } from "./feedInRamp.ts";
import { allocateSellsGreedily, bridgeSellValleys } from "./sellAllocation.ts";
import { consolidateSellSlots } from "./sellConsolidation.ts";
import { allocateArbitragePairs, preBuyAtCheapHours } from "./buyAllocation.ts";
import { allocateHolds, holdNote, plannedHoldSlots } from "./holdAllocation.ts";
import { mergeAcceptedSlots, toPlanned, type PackagingContext } from "./planWindows.ts";
import { terminalValuationFor, type TerminalValuationResult } from "./terminalValue.ts";
import { SLOT_MS } from "./slotDuration.ts";
import type {
  AllocationContext,
  FixedWindow,
  HorizonValuation,
  PlannerInput,
  PlanProjection,
  PlanResult,
  SimResult,
  Slot,
} from "./planner.types.ts";

export { SLOT_MS };

export function generatePlan(input: PlannerInput): PlanResult {
  const knobs = input.knobs;
  const notes: string[] = [];
  const slots = buildSlots(input);
  const cap = input.capacityWh;

  const pricedSlots = slots.filter(slot => slot.spot !== undefined);
  if (!pricedSlots.length) {
    return {
      sells: [],
      buys: [],
      notes: ["No price data in the future — nothing to plan"],
      projection: emptyProjection(input),
      socSeries: [],
    };
  }
  const { valuation, terminal } = horizonValuation(input, pricedSlots);

  const sellW = new Array(slots.length).fill(0);
  const buyW = new Array(slots.length).fill(0);

  const base = simulate(input, slots, sellW, buyW, valuation);
  const feasibleVsBase = (result: SimResult) => result.violationWh <= base.violationWh + 1;

  // ---- Sell allocation (sellAllocation.ts, sellConsolidation.ts), then pre-buying against unavoidable
  // imports and, with a terminal value, stocking up (buyAllocation.ts) ----
  const allocation: AllocationContext = { input, slots, sellW, buyW, valuation, feasibleVsBase };
  const firstSells = allocateSells(allocation, base);
  let { result: current, acceptedSell } = firstSells;
  // Where the note goes without a terminal value too; a second sell pass updates it instead of adding one
  const droppedRunsNoteIndex = notes.length;
  if (firstSells.droppedShortRuns) notes.push(droppedShortRunsNote(firstSells.droppedShortRuns, knobs));
  const preBuy = preBuyAtCheapHours(allocation, current, notes);
  current = preBuy.result;
  const acceptedBuy = preBuy.acceptedBuy;
  // Stocking slots whose energy the second sell pass sells at a later peak: their windows read as arbitrage
  const resoldStockingSlots = new Set<number>();
  if (valuation.endEnergySekPerKwh > 0 && knobs.allow_arbitrage_buying && acceptedBuy.length) {
    // The sells were allocated against the emptier trajectory before the buys; with the battery fuller now, a
    // peak can pay for energy the buy blocks brought in (arbitrage can't pair it: the blocks hold the cheap
    // slots). That is buying to sell, so only with arbitrage allowed.
    const sellingBefore = new Set(acceptedSell);
    const secondSells = allocateSells(allocation, current);
    ({ result: current, acceptedSell } = secondSells);
    if (secondSells.droppedShortRuns) {
      const droppedShortRuns = firstSells.droppedShortRuns + secondSells.droppedShortRuns;
      notes.splice(
        droppedRunsNoteIndex,
        firstSells.droppedShortRuns ? 1 : 0,
        droppedShortRunsNote(droppedShortRuns, knobs)
      );
    }
    const firstStockingSlot = Math.min(...preBuy.stockingBuySlots);
    if (acceptedSell.some(slotIndex => !sellingBefore.has(slotIndex) && slotIndex > firstStockingSlot)) {
      for (const slotIndex of preBuy.stockingBuySlots) resoldStockingSlots.add(slotIndex);
    }
  }
  if (preBuy.stockedKwh > 0) {
    notes.push(
      resoldStockingSlots.size
        ? `Bought ~${preBuy.stockedKwh.toFixed(1)} kWh in one cheap block that a later peak then sells (arbitrage)`
        : `Stocking up ~${preBuy.stockedKwh.toFixed(1)} kWh in one block for after the horizon — end-of-plan energy is worth ${valuation.endEnergySekPerKwh.toFixed(2)} SEK/kWh`
    );
  }

  // ---- Arbitrage pairs (buyAllocation.ts) ----
  const arbitrage = allocateArbitragePairs(allocation, current, acceptedSell, acceptedBuy, notes);
  current = arbitrage.result;

  // ---- With a terminal value, the holds (holdAllocation.ts): last, in the quarters no trade took. Before
  // the buys they "averted" the shortfall at dearer quarters than the pre-buy would have bought at, and left
  // it nothing to do: ~100–230 SEK per winter worse than this in the backtest ----
  const holdPass = allocateHolds(allocation, current);
  current = holdPass.result;

  // ---- Merge windows (after all passes so arbitrage sells merge in too) ----
  const { windows: sellWindows, droppedShort } = mergeAcceptedSlots(
    slots,
    acceptedSell,
    sellW,
    "sell",
    knobs.min_window_minutes
  );
  if (droppedShort) {
    notes.push(`Dropped ${droppedShort} sell window(s) shorter than ${knobs.min_window_minutes} min`);
    for (const slotIndex of acceptedSell) {
      if (!sellWindows.some(window => window.slotIndexes.includes(slotIndex))) sellW[slotIndex] = 0;
    }
    current = simulate(input, slots, sellW, buyW, valuation);
  }

  const { windows: buyWindows } = mergeAcceptedSlots(slots, acceptedBuy, buyW, "buy", knobs.min_window_minutes);

  // ---- Hold windows, as buy windows at the hold power: the hold pass left only runs of at least
  // hold_min_window_minutes, and dropping a short sell run above frees no quarter a hold could have had ----
  const holdSlots = plannedHoldSlots(allocation);
  const { windows: holdWindows } = mergeAcceptedSlots(
    slots,
    holdSlots,
    slots.map(slot => slot.holdW),
    "buy",
    knobs.hold_min_window_minutes
  );
  const holdPlanNote = holdNote(allocation, holdSlots, holdWindows.length, holdPass.budgetCut);
  if (holdPlanNote) notes.push(holdPlanNote);

  // ---- Package result ----
  const spotsAll = pricedSlots.map(slot => slot.spot!).sort((lower, higher) => lower - higher);
  const packaging: PackagingContext = {
    input,
    slots,
    finalResult: current,
    spotsAll,
    arbitrageBuySlots: new Set([...arbitrage.arbitrageBuySlots, ...resoldStockingSlots]),
    stockingBuySlots: preBuy.stockingBuySlots,
    holdSlots: new Set(holdSlots),
    endEnergySekPerKwh: valuation.endEnergySekPerKwh,
  };
  const sells = sellWindows.map(window => toPlanned(window, packaging));
  // A hold chained to a buy block is a power step between two windows, ordered by start like the schedule
  const buys = [...buyWindows, ...holdWindows]
    .sort((earlier, later) => earlier.startMs - later.startMs)
    .map(window => toPlanned(window, packaging));

  if (base.violationWh > 1) {
    notes.push(
      `Reserve already breached in the no-trade projection (forecast shortfall of ${(base.violationWh / 1000).toFixed(1)} kWh·slots) — selling only where it doesn't worsen it`
    );
  }
  notes.push(
    `Horizon ${new Date(Math.max(input.nowMs, pricedSlots[0].startMs)).toISOString()} → ${new Date(pricedSlots[pricedSlots.length - 1].endMs).toISOString()} (+${input.constraintTailHours}h reserve tail)`
  );
  if (knobs.extra_reserve_kwh > 0) notes.push(`User extra reserve of ${knobs.extra_reserve_kwh} kWh respected`);
  const terminalNote = terminalValueNote(terminal, current);
  if (terminalNote) notes.push(terminalNote);

  const projection: PlanProjection = {
    startSocPercent: input.socPercent,
    minSocPercent: Math.round((current.minSocWh / cap) * 1000) / 10,
    minSocAt: new Date(current.minSocMs).toISOString(),
    endSocPercent: Math.round((current.endSocWh / cap) * 1000) / 10,
    plannedSellKwh: Math.round(current.sellExportWh / 100) / 10,
    autoExportKwh: Math.round(current.autoExportWh / 100) / 10,
    unavoidableImportKwh: Math.round(current.importWh / 100) / 10,
    plannedBuyKwh: Math.round(current.boughtWh / 100) / 10,
    // Cash only: the end-of-plan credit is an estimate, reported apart
    estimatedRevenueSek: Math.round((current.revenueSek - current.endEnergyValueSek) * 10) / 10,
    baselineRevenueSek: Math.round((base.revenueSek - base.endEnergyValueSek) * 10) / 10,
    ...(terminal.valuation ? { endEnergyValueSek: Math.round(current.endEnergyValueSek * 10) / 10 } : {}),
  };

  const socSeries = slots.map((slot, index) => ({
    startMs: slot.startMs,
    socPercent: Math.round((current.socAfterSlot[index] / cap) * 1000) / 10,
    autoExportW: current.autoExportWPerSlot[index],
  }));

  return { sells, buys, notes, projection, socSeries };
}

/**
 * The sell passes: the greedy, highest spot first, then bridging short valleys (sellAllocation.ts), then
 * defragmenting what the greedy scattered (sellConsolidation.ts). Adds to whatever the candidate schedule
 * already holds; returns the simulation, every slot selling afterwards (sellW is the source of truth
 * once consolidation has moved things) and how many too-short runs consolidation dropped.
 */
function allocateSells(
  allocation: AllocationContext,
  resultSoFar: SimResult
): { result: SimResult; acceptedSell: number[]; droppedShortRuns: number } {
  const { input, slots, sellW, buyW, valuation, feasibleVsBase } = allocation;
  const greedy = allocateSellsGreedily(allocation, resultSoFar);
  // Every slot selling now, so a second pass bridges valleys between its sells and the first pass's too
  const sellingSlots = slots.flatMap((slot, slotIndex) => (sellW[slotIndex] > 0 ? [slotIndex] : []));
  const bridged = bridgeSellValleys(allocation, greedy.result, sellingSlots);
  const consolidated = consolidateSellSlots(input, slots, sellW, buyW, valuation, feasibleVsBase, bridged);
  const acceptedSell: number[] = [];
  for (let i = 0; i < slots.length; i++) if (sellW[i] > 0) acceptedSell.push(i);
  return { result: consolidated.result, acceptedSell, droppedShortRuns: consolidated.droppedShortRuns };
}

function droppedShortRunsNote(droppedShortRuns: number, knobs: PlannerInput["knobs"]): string {
  return `Dropped ${droppedShortRuns} sell run(s) shorter than ${knobs.min_window_minutes} min and re-spent their budget`;
}

/**
 * Project SOC with only the given fixed windows (no new allocation). Used by the periodic guard to
 * check whether the already-written schedule is still safe under live SOC + fresh forecasts.
 */
export function projectWithFixedWindows(input: PlannerInput): {
  violationWh: number;
  minSocPercent: number;
  minSocAt: string;
  unavoidableImportKwh: number;
  endSocPercent: number;
  /** Cash, the same accounting as generatePlan's estimatedRevenueSek — comparable across plans on equal inputs */
  revenueSek: number;
  /** As generatePlan's endEnergyValueSek, 0 without a terminal value: compare plans on revenueSek plus this */
  endEnergyValueSek: number;
} {
  const slots = buildSlots(input);
  const pricedSlots = slots.filter(slot => slot.spot !== undefined);
  const { valuation } = horizonValuation(input, pricedSlots);
  const result = simulate(input, slots, new Array(slots.length).fill(0), new Array(slots.length).fill(0), valuation);
  return {
    violationWh: result.violationWh,
    minSocPercent: Math.round((result.minSocWh / input.capacityWh) * 1000) / 10,
    minSocAt: new Date(result.minSocMs).toISOString(),
    unavoidableImportKwh: Math.round(result.importWh / 100) / 10,
    endSocPercent: Math.round((result.endSocWh / input.capacityWh) * 1000) / 10,
    revenueSek: Math.round((result.revenueSek - result.endEnergyValueSek) * 10) / 10,
    endEnergyValueSek: Math.round(result.endEnergyValueSek * 10) / 10,
  };
}

/**
 * How a plan for this input prices what lies past the published prices: the unpriced constraint tail at
 * the median of the last priced day (a conservative stand-in) and the energy left at the end at nothing.
 * With an active terminal value (terminalValue.ts) that energy is worth V, and the tail is priced at the
 * expected spot when that is the higher of the two: a cheaper tail would make room for the tail's PV
 * overflow look worth less and sell more now, trading the conservative tail for mean reversion just when
 * prices run above their trailing mean. generatePlan and projectWithFixedWindows share it, so a fresh plan
 * and a replayed schedule count the same things (the opportunistic replan compares their value).
 */
function horizonValuation(
  input: PlannerInput,
  pricedSlots: Slot[]
): { valuation: HorizonValuation; terminal: TerminalValuationResult } {
  const terminal = terminalValuationFor(input);
  const lastDaySpots = pricedSlots
    .slice(-96)
    .map(slot => slot.spot!)
    .sort((lower, higher) => lower - higher);
  const lastDayMedianSpot = lastDaySpots[Math.floor(lastDaySpots.length / 2)] ?? 0.5;
  return {
    valuation: {
      tailSpot: Math.max(lastDayMedianSpot, terminal.valuation?.expectedSpot ?? lastDayMedianSpot),
      endEnergySekPerKwh: terminal.valuation?.endEnergySekPerKwh ?? 0,
    },
    terminal,
  };
}

/** The plan note on the terminal value: what end-of-plan energy is worth and what the plan leaves, or why it has none */
function terminalValueNote(terminal: TerminalValuationResult, finalResult: SimResult): string | undefined {
  if (terminal.unavailable) return `End-of-plan energy not valued: ${terminal.unavailable}`;
  const valuation = terminal.valuation;
  if (!valuation) return undefined;
  const leftKwh = valuation.endEnergySekPerKwh > 0 ? finalResult.endEnergyValueSek / valuation.endEnergySekPerKwh : 0;
  return `End-of-plan energy valued at ${valuation.endEnergySekPerKwh.toFixed(2)} SEK/kWh (${valuation.basis}): the ${leftKwh.toFixed(1)} kWh left above the emergency floor are worth ${finalResult.endEnergyValueSek.toFixed(1)} SEK, not counted in the revenue figures`;
}

function windowPowerAt(windows: FixedWindow[], startMs: number, endMs: number): number {
  let max = 0;
  for (const window of windows) {
    if (window.startMs < endMs && window.endMs > startMs) max = Math.max(max, window.watts);
  }
  return max;
}

/**
 * The plan's 15-min slots from the current one (partial: it starts at nowMs) through the constraint
 * tail, with their forecasts and fixed windows. Slot 0 also carries the feed-in level a sell window
 * running at nowMs has reached, so the simulation doesn't ramp it from 0 a second time, and when that
 * window started, so a new window continuing it isn't keyed earlier.
 */
export function buildSlots(input: PlannerInput): Slot[] {
  const { prices, nowMs, constraintTailHours, houseLoadWattsAt, fixedSells, fixedBuys } = input;
  const slots: Slot[] = [];
  const relevantPrices = prices
    .filter(price => price.startMs + SLOT_MS > nowMs)
    .sort((earlier, later) => earlier.startMs - later.startMs);
  const pricedEndMs = relevantPrices.length ? relevantPrices[relevantPrices.length - 1].startMs + SLOT_MS : nowMs;
  const tailEndMs = pricedEndMs + constraintTailHours * 3600 * 1000;

  const pushSlot = (startMs: number, spot: number | undefined) => {
    const endMs = startMs + SLOT_MS;
    const effectiveStart = Math.max(startMs, nowMs);
    const durationH = (endMs - effectiveStart) / 3600_000;
    if (durationH <= 0) return;
    const midMs = (effectiveStart + endMs) / 2;
    slots.push({
      startMs,
      endMs,
      durationH,
      spot,
      pvW: Math.max(0, input.solarAverageWattsBetween?.(effectiveStart, endMs) ?? input.solarWattsAt(midMs)),
      houseW: Math.max(0, houseLoadWattsAt(midMs)),
      fixedSellW: windowPowerAt(fixedSells, startMs, endMs),
      fixedBuyW: windowPowerAt(fixedBuys, startMs, endMs),
      feedInAtStartW: 0,
      runningWindowStartMs: undefined,
      holdW: 0,
    });
  };

  for (const price of relevantPrices) pushSlot(price.startMs, price.spot);
  for (let slotStartMs = pricedEndMs; slotStartMs < tailEndMs; slotStartMs += SLOT_MS) {
    pushSlot(slotStartMs, undefined);
  }
  if (slots.length) {
    const runningFeed = runningFeedAtNow({
      sellWindows: [...fixedSells, ...(input.runningSellSchedule ?? [])],
      nowMs,
      maxExportW: input.knobs.inverter_max_ac_output_watts - slots[0].houseW,
      rampWattsPerMinute: sellRampWattsPerMinute(input.knobs),
      measuredFeedInW: input.measuredFeedInW,
    });
    slots[0].feedInAtStartW = runningFeed.levelW;
    slots[0].runningWindowStartMs = runningFeed.windowStartMs;
  }
  return slots;
}

function emptyProjection(input: PlannerInput): PlanProjection {
  return {
    startSocPercent: input.socPercent,
    minSocPercent: input.socPercent,
    minSocAt: new Date(input.nowMs).toISOString(),
    endSocPercent: input.socPercent,
    plannedSellKwh: 0,
    autoExportKwh: 0,
    unavoidableImportKwh: 0,
    plannedBuyKwh: 0,
    estimatedRevenueSek: 0,
    baselineRevenueSek: 0,
  };
}
