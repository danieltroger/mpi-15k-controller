/**
 * Pure day-ahead trading planner. No IO, no reading of the clock — everything comes in via PlannerInput,
 * so it can be simulated/tested standalone.
 *
 * Economics (E.ON, SE3, 2026): buying costs ≈ (spot + ~1.19 SEK surcharges) × 1.25 VAT ≈ 1.25×spot + 1.48 SEK/kWh,
 * selling earns ≈ spot + ~0.09 SEK/kWh. Buying is therefore only scheduled when it beats those numbers:
 * to avert an even more expensive unavoidable import (battery empty → house pulls from grid), or as
 * arbitrage when a later sell clears the full fee + round-trip-loss + margin stack.
 *
 * Strategy: simulate battery SOC over the price horizon (+ a constraint tail covering the following night)
 * using solar + consumption forecasts (simulate.ts), then greedily allocate 15-min sell slots from the
 * highest spot price down, keeping every accepted plan feasible (SOC never below the planner floor + user
 * reserve). Selling energy the battery couldn't have absorbed anyway (would have auto-exported when full)
 * is naturally handled by the simulation's revenue accounting.
 *
 * Fragmented schedules are allowed when they genuinely price better (a stop/start costs nothing but the
 * modeled ramp), but a consolidation pass (sellConsolidation.ts) repairs fragmentation the greedy's
 * accept order created for no gain, and captures fractional leftover budget as reduced-power window
 * extensions. The reserve floor relaxes to planner_soc_floor_sunny_percent in slots where forecast PV
 * covers the house.
 */

import { overlapsVeto, simulate, slotTradableForSell } from "./simulate.ts";
import { consolidateSellSlots } from "./sellConsolidation.ts";
import type {
  FixedWindow,
  PlannedWindow,
  PlannerInput,
  PlanProjection,
  PlanResult,
  SimResult,
  Slot,
} from "./planner.types.ts";

export const SLOT_MS = 15 * 60 * 1000;

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
    .sort((a, b) => a - b);
  const tailSpot = lastDaySpots[Math.floor(lastDaySpots.length / 2)] ?? 0.5;

  const sellW = new Array(slots.length).fill(0);
  const buyW = new Array(slots.length).fill(0);

  const base = simulate(input, slots, sellW, buyW, tailSpot);
  const feasibleVsBase = (result: SimResult) => result.violationWh <= base.violationWh + 1;

  // ---- Greedy sell allocation, highest spot first ----
  const sellCandidates = slots
    .map((slot, slotIndex) => ({ slot, slotIndex }))
    .filter(
      ({ slot }) => slotTradableForSell(slot, input.sellVetoWindows) && slot.spot! >= knobs.min_sell_spot_sek_per_kwh
    )
    .sort((a, b) => b.slot.spot! - a.slot.spot!);

  let current = base;
  const acceptedSell: number[] = [];
  for (const { slotIndex } of sellCandidates) {
    sellW[slotIndex] = knobs.max_sell_power_watts;
    const trial = simulate(input, slots, sellW, buyW, tailSpot);
    const gain = trial.revenueSek - current.revenueSek;
    if (feasibleVsBase(trial) && gain >= knobs.min_gain_sek_per_slot) {
      current = trial;
      acceptedSell.push(slotIndex);
    } else {
      sellW[slotIndex] = 0;
    }
  }

  // Bridge short price valleys between accepted windows: every feed stop/start restarts the
  // slow feed-in ramp (which the simulation prices in), so selling through a shallow dip is
  // usually better than pausing — and nobody wants a schedule with a 30-min hole in it.
  // Accept a bounded revenue loss per bridged slot; the sim decides using ramp + prices.
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

  // Defragment what the greedy scattered (see sellConsolidation.ts) — sellW is the source of
  // truth afterwards, so rebuild the accepted list from it
  current = consolidateSellSlots(input, slots, sellW, buyW, tailSpot, feasibleVsBase, current);
  acceptedSell.length = 0;
  for (let i = 0; i < slots.length; i++) if (sellW[i] > 0) acceptedSell.push(i);

  // ---- Buy allocation, pass 1: avert projected unavoidable imports, cheapest slots first ----
  const acceptedBuy: number[] = [];
  if (current.importWh > 500 && knobs.max_buy_power_watts > 0) {
    notes.push(
      `Projected unavoidable import of ${(current.importWh / 1000).toFixed(1)} kWh — evaluating pre-buying at cheap hours`
    );
    const buyCandidates = slots
      .map((slot, slotIndex) => ({ slot, slotIndex }))
      .filter(
        ({ slot, slotIndex }) =>
          slot.spot !== undefined &&
          slot.fixedSellW === 0 &&
          sellW[slotIndex] === 0 &&
          !overlapsVeto(slot, input.buyVetoWindows)
      )
      .sort((a, b) => a.slot.spot! - b.slot.spot!);
    for (const { slotIndex } of buyCandidates) {
      if (sellW[slotIndex] > 0) continue;
      buyW[slotIndex] = knobs.max_buy_power_watts;
      const trial = simulate(input, slots, sellW, buyW, tailSpot);
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

  // ---- Buy allocation, pass 2: arbitrage. Buy cheap purely to re-sell expensive when the spread
  // beats fees + VAT + round-trip losses + margin. Buys and sells only pay off together (bought
  // energy has no value without a later sell window), so they are trialled as pairs.
  const arbitrageBuySlots = new Set<number>();
  if (knobs.allow_arbitrage_buying && knobs.max_buy_power_watts > 0) {
    const roundTrip = knobs.charge_efficiency * knobs.discharge_efficiency;
    const tradable = (slotIndex: number) =>
      slots[slotIndex].spot !== undefined &&
      sellW[slotIndex] === 0 &&
      buyW[slotIndex] === 0 &&
      slots[slotIndex].fixedSellW === 0 &&
      slots[slotIndex].fixedBuyW === 0;
    const buyPool = slots
      .map((slot, slotIndex) => ({ slot, slotIndex }))
      .filter(({ slot, slotIndex }) => tradable(slotIndex) && !overlapsVeto(slot, input.buyVetoWindows))
      .sort((a, b) => a.slot.spot! - b.slot.spot!);
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
        if (tradable(slotIndex) && !buyGroup.includes(slotIndex)) buyGroup.push(slotIndex);
        if (buyGroup.length === buysPerSell) break;
      }
      if (buyGroup.length < buysPerSell) break;
      const lastBuyStart = Math.max(...buyGroup.map(slotIndex => slots[slotIndex].startMs));
      const sellPool = slots
        .map((slot, slotIndex) => ({ slot, slotIndex }))
        .filter(
          ({ slot, slotIndex }) =>
            tradable(slotIndex) &&
            slot.startMs > lastBuyStart &&
            slot.spot! >= knobs.min_sell_spot_sek_per_kwh &&
            !overlapsVeto(slot, input.sellVetoWindows)
        )
        .sort((a, b) => b.slot.spot! - a.slot.spot!);
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
        const trial = simulate(input, slots, sellW, buyW, tailSpot);
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
  const spotsAll = pricedSlots.map(slot => slot.spot!).sort((a, b) => a - b);
  const percentileOf = (value: number) =>
    Math.round((spotsAll.filter(spot => spot <= value).length / spotsAll.length) * 100);

  const toPlanned = (mergedWindow: MergedWindow): PlannedWindow => {
    const spots = mergedWindow.slotIndexes.map(slotIndex => slots[slotIndex].spot!).filter(spot => spot !== undefined);
    const avgSpot = spots.reduce((sum, spot) => sum + spot, 0) / Math.max(spots.length, 1);
    const socBefore =
      current.socAfterSlot[Math.max(0, mergedWindow.slotIndexes[0] - 1)] ?? (input.socPercent / 100) * cap;
    const socAfter = current.socAfterSlot[mergedWindow.slotIndexes[mergedWindow.slotIndexes.length - 1]];
    let expectedKwh: number;
    if (mergedWindow.kind === "sell") {
      expectedKwh = mergedWindow.slotIndexes.reduce((sum, slotIndex) => {
        const slot = slots[slotIndex];
        const exportW = Math.max(0, Math.min(mergedWindow.watts, knobs.inverter_max_ac_output_watts - slot.houseW));
        return sum + (exportW * slot.durationH) / 1000;
      }, 0);
    } else {
      expectedKwh = mergedWindow.slotIndexes.reduce(
        (sum, slotIndex) => sum + (mergedWindow.watts * slots[slotIndex].durationH) / 1000,
        0
      );
    }
    const isArbitrage =
      mergedWindow.kind === "buy" && mergedWindow.slotIndexes.some(slotIndex => arbitrageBuySlots.has(slotIndex));
    const reason =
      mergedWindow.kind === "sell"
        ? `spot avg ${avgSpot.toFixed(2)} SEK/kWh (P${percentileOf(avgSpot)} of horizon), ~${expectedKwh.toFixed(0)} kWh, SOC ${Math.round((socBefore / cap) * 100)}%→${Math.round((socAfter / cap) * 100)}%`
        : isArbitrage
          ? `arbitrage: buying ~${expectedKwh.toFixed(0)} kWh at ${avgSpot.toFixed(2)} SEK/kWh (P${percentileOf(avgSpot)}) to re-sell at the later price peak`
          : `cheap spot avg ${avgSpot.toFixed(2)} SEK/kWh (P${percentileOf(avgSpot)}), pre-buying ~${expectedKwh.toFixed(0)} kWh to avoid pricier unavoidable import`;
    return {
      startMs: mergedWindow.startMs,
      endMs: mergedWindow.endMs,
      watts: mergedWindow.watts,
      kind: mergedWindow.kind,
      reason,
      expectedKwh,
      avgSpot,
    };
  };

  const sells = sellWindows.map(toPlanned);
  const buys = buyWindows.map(toPlanned);

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
    .sort((a, b) => a - b);
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

function buildSlots(input: PlannerInput): Slot[] {
  const { prices, nowMs, constraintTailHours, houseLoadWattsAt, fixedSells, fixedBuys } = input;
  const slots: Slot[] = [];
  const relevantPrices = prices.filter(price => price.startMs + SLOT_MS > nowMs).sort((a, b) => a.startMs - b.startMs);
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
      pvW: Math.max(0, input.solarWattsAt(midMs)),
      houseW: Math.max(0, houseLoadWattsAt(midMs)),
      fixedSellW: windowPowerAt(fixedSells, startMs, endMs),
      fixedBuyW: windowPowerAt(fixedBuys, startMs, endMs),
    });
  };

  for (const price of relevantPrices) pushSlot(price.startMs, price.spot);
  for (let slotStartMs = pricedEndMs; slotStartMs < tailEndMs; slotStartMs += SLOT_MS) {
    pushSlot(slotStartMs, undefined);
  }
  return slots;
}

type MergedWindow = { startMs: number; endMs: number; watts: number; kind: "sell" | "buy"; slotIndexes: number[] };

function mergeAcceptedSlots(
  slots: Slot[],
  accepted: number[],
  wattsBySlot: number[],
  kind: "sell" | "buy",
  min_window_minutes: number
): {
  windows: MergedWindow[];
  droppedShort: number;
} {
  const sorted = [...accepted].sort((a, b) => a - b);
  // Group into time-contiguous chains first: a power step mid-chain later splits into adjacent
  // windows that are still one continuous feed, so the minimum-length rule judges whole chains.
  const chains: number[][] = [];
  for (const slotIndex of sorted) {
    const lastChain = chains[chains.length - 1];
    const previous = lastChain?.[lastChain.length - 1];
    if (previous !== undefined && slots[slotIndex].startMs === slots[previous].endMs) lastChain.push(slotIndex);
    else chains.push([slotIndex]);
  }
  const windows: MergedWindow[] = [];
  let droppedShort = 0;
  for (const chain of chains) {
    const chainMinutes = (slots[chain[chain.length - 1]].endMs - slots[chain[0]].startMs) / 60000;
    if (chainMinutes < min_window_minutes) {
      droppedShort++;
      continue;
    }
    for (const slotIndex of chain) {
      const last = windows[windows.length - 1];
      if (last && slots[slotIndex].startMs === last.endMs && wattsBySlot[slotIndex] === last.watts) {
        last.endMs = slots[slotIndex].endMs;
        last.slotIndexes.push(slotIndex);
      } else {
        windows.push({
          startMs: slots[slotIndex].startMs,
          endMs: slots[slotIndex].endMs,
          watts: wattsBySlot[slotIndex],
          kind,
          slotIndexes: [slotIndex],
        });
      }
    }
  }
  return { windows, droppedShort };
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
