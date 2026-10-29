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
 */

import { simulate } from "./simulate.ts";
import { feedInReachedAtNow, sellRampWattsPerMinute } from "./feedInRamp.ts";
import { allocateSellsGreedily, bridgeSellValleys } from "./sellAllocation.ts";
import { consolidateSellSlots } from "./sellConsolidation.ts";
import { allocateArbitragePairs, preBuyAgainstUnavoidableImport } from "./buyAllocation.ts";
import { mergeAcceptedSlots, toPlanned, type PackagingContext } from "./planWindows.ts";
import { SLOT_MS } from "./slotDuration.ts";
import type {
  AllocationContext,
  FixedWindow,
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
  // Conservative valuation for the unpriced constraint tail: median of the last priced day
  const lastDaySpots = pricedSlots
    .slice(-96)
    .map(slot => slot.spot!)
    .sort((lower, higher) => lower - higher);
  const tailSpot = lastDaySpots[Math.floor(lastDaySpots.length / 2)] ?? 0.5;

  const sellW = new Array(slots.length).fill(0);
  const buyW = new Array(slots.length).fill(0);

  const base = simulate(input, slots, sellW, buyW, tailSpot);
  const feasibleVsBase = (result: SimResult) => result.violationWh <= base.violationWh + 1;

  // ---- Sell allocation: the greedy, highest spot first, then bridging short valleys (sellAllocation.ts) ----
  const allocation: AllocationContext = { input, slots, sellW, buyW, tailSpot, feasibleVsBase };
  const greedy = allocateSellsGreedily(allocation, base);
  let current = greedy.result;
  const acceptedSell = greedy.acceptedSell;
  current = bridgeSellValleys(allocation, current, acceptedSell);

  // Defragment what the greedy scattered (see sellConsolidation.ts) — sellW is the source of
  // truth afterwards, so rebuild the accepted list from it
  const consolidated = consolidateSellSlots(input, slots, sellW, buyW, tailSpot, feasibleVsBase, current);
  current = consolidated.result;
  if (consolidated.droppedShortRuns) {
    notes.push(
      `Dropped ${consolidated.droppedShortRuns} sell run(s) shorter than ${knobs.min_window_minutes} min and re-spent their budget`
    );
  }
  acceptedSell.length = 0;
  for (let i = 0; i < slots.length; i++) if (sellW[i] > 0) acceptedSell.push(i);

  // ---- Buy allocation: pre-buying against unavoidable imports, then arbitrage pairs (buyAllocation.ts) ----
  const preBuy = preBuyAgainstUnavoidableImport(allocation, current, notes);
  current = preBuy.result;
  const acceptedBuy = preBuy.acceptedBuy;
  const arbitrage = allocateArbitragePairs(allocation, current, acceptedSell, acceptedBuy, notes);
  current = arbitrage.result;

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
    current = simulate(input, slots, sellW, buyW, tailSpot);
  }

  const { windows: buyWindows } = mergeAcceptedSlots(slots, acceptedBuy, buyW, "buy", knobs.min_window_minutes);

  // ---- Package result ----
  const spotsAll = pricedSlots.map(slot => slot.spot!).sort((lower, higher) => lower - higher);
  const packaging: PackagingContext = {
    input,
    slots,
    finalResult: current,
    spotsAll,
    arbitrageBuySlots: arbitrage.arbitrageBuySlots,
  };
  const sells = sellWindows.map(window => toPlanned(window, packaging));
  const buys = buyWindows.map(window => toPlanned(window, packaging));

  if (base.violationWh > 1) {
    notes.push(
      `Reserve already breached in the no-trade projection (forecast shortfall of ${(base.violationWh / 1000).toFixed(1)} kWh·slots) — selling only where it doesn't worsen it`
    );
  }
  notes.push(
    `Horizon ${new Date(Math.max(input.nowMs, pricedSlots[0].startMs)).toISOString()} → ${new Date(pricedSlots[pricedSlots.length - 1].endMs).toISOString()} (+${input.constraintTailHours}h reserve tail)`
  );
  if (knobs.extra_reserve_kwh > 0) notes.push(`User extra reserve of ${knobs.extra_reserve_kwh} kWh respected`);

  const projection: PlanProjection = {
    startSocPercent: input.socPercent,
    minSocPercent: Math.round((current.minSocWh / cap) * 1000) / 10,
    minSocAt: new Date(current.minSocMs).toISOString(),
    endSocPercent: Math.round((current.endSocWh / cap) * 1000) / 10,
    plannedSellKwh: Math.round(current.sellExportWh / 100) / 10,
    autoExportKwh: Math.round(current.autoExportWh / 100) / 10,
    unavoidableImportKwh: Math.round(current.importWh / 100) / 10,
    plannedBuyKwh: Math.round(current.boughtWh / 100) / 10,
    estimatedRevenueSek: Math.round(current.revenueSek * 10) / 10,
    baselineRevenueSek: Math.round(base.revenueSek * 10) / 10,
  };

  const socSeries = slots.map((slot, index) => ({
    startMs: slot.startMs,
    socPercent: Math.round((current.socAfterSlot[index] / cap) * 1000) / 10,
    autoExportW: current.autoExportWPerSlot[index],
  }));

  return { sells, buys, notes, projection, socSeries };
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
  /** Same revenue accounting as generatePlan's projection — comparable across plans on equal inputs */
  revenueSek: number;
} {
  const slots = buildSlots(input);
  const pricedSlots = slots.filter(slot => slot.spot !== undefined);
  const lastDaySpots = pricedSlots
    .slice(-96)
    .map(slot => slot.spot!)
    .sort((lower, higher) => lower - higher);
  const tailSpot = lastDaySpots[Math.floor(lastDaySpots.length / 2)] ?? 0.5;
  const result = simulate(input, slots, new Array(slots.length).fill(0), new Array(slots.length).fill(0), tailSpot);
  return {
    violationWh: result.violationWh,
    minSocPercent: Math.round((result.minSocWh / input.capacityWh) * 1000) / 10,
    minSocAt: new Date(result.minSocMs).toISOString(),
    unavoidableImportKwh: Math.round(result.importWh / 100) / 10,
    endSocPercent: Math.round((result.endSocWh / input.capacityWh) * 1000) / 10,
    revenueSek: Math.round(result.revenueSek * 10) / 10,
  };
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
 * running at nowMs has reached, so the simulation doesn't ramp it from 0 a second time.
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
    });
  };

  for (const price of relevantPrices) pushSlot(price.startMs, price.spot);
  for (let slotStartMs = pricedEndMs; slotStartMs < tailEndMs; slotStartMs += SLOT_MS) {
    pushSlot(slotStartMs, undefined);
  }
  if (slots.length) {
    slots[0].feedInAtStartW = feedInReachedAtNow(
      [...fixedSells, ...(input.runningSellSchedule ?? [])],
      nowMs,
      input.knobs.inverter_max_ac_output_watts - slots[0].houseW,
      sellRampWattsPerMinute(input.knobs)
    );
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
