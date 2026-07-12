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
  const k = input.knobs;
  const notes: string[] = [];
  const slots = buildSlots(input);
  const cap = input.capacityWh;

  const pricedSlots = slots.filter(s => s.spot !== undefined);
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
    .map(s => s.spot!)
    .sort((a, b) => a - b);
  const tailSpot = lastDaySpots[Math.floor(lastDaySpots.length / 2)] ?? 0.5;

  const sellW = new Array(slots.length).fill(0);
  const buyW = new Array(slots.length).fill(0);

  const base = simulate(input, slots, sellW, buyW, tailSpot);
  const feasibleVsBase = (r: SimResult) => r.violationWh <= base.violationWh + 1;

  // ---- Greedy sell allocation, highest spot first ----
  const sellCandidates = slots
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => slotTradableForSell(s, input.sellVetoWindows) && s.spot! >= k.min_sell_spot_sek_per_kwh)
    .sort((a, b) => b.s.spot! - a.s.spot!);

  let current = base;
  const acceptedSell: number[] = [];
  for (const { i } of sellCandidates) {
    sellW[i] = k.max_sell_power_watts;
    const trial = simulate(input, slots, sellW, buyW, tailSpot);
    const gain = trial.revenueSek - current.revenueSek;
    if (feasibleVsBase(trial) && gain >= k.min_gain_sek_per_slot) {
      current = trial;
      acceptedSell.push(i);
    } else {
      sellW[i] = 0;
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
      for (const j of fillable) sellW[j] = k.max_sell_power_watts;
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
  if (current.importWh > 500 && k.max_buy_power_watts > 0) {
    notes.push(
      `Projected unavoidable import of ${(current.importWh / 1000).toFixed(1)} kWh — evaluating pre-buying at cheap hours`
    );
    const buyCandidates = slots
      .map((s, i) => ({ s, i }))
      .filter(
        ({ s, i }) =>
          s.spot !== undefined && s.fixedSellW === 0 && sellW[i] === 0 && !overlapsVeto(s, input.buyVetoWindows)
      )
      .sort((a, b) => a.s.spot! - b.s.spot!);
    for (const { i } of buyCandidates) {
      if (sellW[i] > 0) continue;
      buyW[i] = k.max_buy_power_watts;
      const trial = simulate(input, slots, sellW, buyW, tailSpot);
      const gain = trial.revenueSek - current.revenueSek;
      const extraBoughtKwh = (trial.boughtWh - current.boughtWh) / 1000;
      if (feasibleVsBase(trial) && extraBoughtKwh > 0 && gain / extraBoughtKwh >= k.min_buy_saving_sek_per_kwh) {
        current = trial;
        acceptedBuy.push(i);
      } else {
        buyW[i] = 0;
      }
      if (current.importWh < 500) break;
    }
  }

  // ---- Buy allocation, pass 2: arbitrage. Buy cheap purely to re-sell expensive when the spread
  // beats fees + VAT + round-trip losses + margin. Buys and sells only pay off together (bought
  // energy has no value without a later sell window), so they are trialled as pairs.
  const arbitrageBuySlots = new Set<number>();
  if (k.allow_arbitrage_buying && k.max_buy_power_watts > 0) {
    const roundTrip = k.charge_efficiency * k.discharge_efficiency;
    const tradable = (i: number) =>
      slots[i].spot !== undefined &&
      sellW[i] === 0 &&
      buyW[i] === 0 &&
      slots[i].fixedSellW === 0 &&
      slots[i].fixedBuyW === 0;
    const buyPool = slots
      .map((s, i) => ({ s, i }))
      .filter(({ s, i }) => tradable(i) && !overlapsVeto(s, input.buyVetoWindows))
      .sort((a, b) => a.s.spot! - b.s.spot!);
    // A sold slot moves more energy out than one bought slot puts in (after losses), so a
    // 1:1 pairing is net-battery-negative and would always fail under a binding reserve floor.
    // Buy enough slots per sell slot to keep the pair battery-neutral or better.
    const buySlotKwh = (k.max_buy_power_watts * 0.25) / 1000;
    const sellSlotKwh = (Math.min(k.max_sell_power_watts, k.inverter_max_ac_output_watts) * 0.25) / 1000;
    const buysPerSell = Math.max(1, Math.ceil(sellSlotKwh / (buySlotKwh * roundTrip)));
    let misses = 0;
    let pairs = 0;
    while (pairs < 60 && misses < 4) {
      const buyGroup: number[] = [];
      for (const { i } of buyPool) {
        if (tradable(i) && !buyGroup.includes(i)) buyGroup.push(i);
        if (buyGroup.length === buysPerSell) break;
      }
      if (buyGroup.length < buysPerSell) break;
      const lastBuyStart = Math.max(...buyGroup.map(i => slots[i].startMs));
      const sellPool = slots
        .map((s, i) => ({ s, i }))
        .filter(
          ({ s, i }) =>
            tradable(i) &&
            s.startMs > lastBuyStart &&
            s.spot! >= k.min_sell_spot_sek_per_kwh &&
            !overlapsVeto(s, input.sellVetoWindows)
        )
        .sort((a, b2) => b2.s.spot! - a.s.spot!);
      if (!sellPool.length) break;
      // Even the best possible pairing must clear the margin on prices alone, else nothing can
      const avgBuySpot = buyGroup.reduce((sum, i) => sum + slots[i].spot!, 0) / buyGroup.length;
      const bestPossible =
        (sellPool[0].s.spot! + k.sell_bonus_sek_per_kwh) * roundTrip -
        (avgBuySpot + k.buy_surcharges_sek_per_kwh) * k.vat_multiplier;
      if (bestPossible < k.min_buy_saving_sek_per_kwh) break;
      let matched = false;
      for (const { i: sellIdx } of sellPool.slice(0, 3)) {
        for (const b of buyGroup) buyW[b] = k.max_buy_power_watts;
        sellW[sellIdx] = k.max_sell_power_watts;
        const trial = simulate(input, slots, sellW, buyW, tailSpot);
        const gain = trial.revenueSek - current.revenueSek;
        const extraBoughtKwh = (trial.boughtWh - current.boughtWh) / 1000;
        if (feasibleVsBase(trial) && extraBoughtKwh > 0.1 && gain / extraBoughtKwh >= k.min_buy_saving_sek_per_kwh) {
          current = trial;
          for (const b of buyGroup) {
            acceptedBuy.push(b);
            arbitrageBuySlots.add(b);
          }
          acceptedSell.push(sellIdx);
          matched = true;
          pairs++;
          break;
        }
        for (const b of buyGroup) buyW[b] = 0;
        sellW[sellIdx] = 0;
      }
      if (matched) {
        misses = 0;
      } else {
        misses++;
        // These cheapest buys couldn't pair profitably — drop the cheapest one and retry with the next mix
        const dropIdx = buyPool.findIndex(({ i }) => i === buyGroup[0]);
        if (dropIdx >= 0) buyPool.splice(dropIdx, 1);
        else break;
      }
    }
    if (pairs) {
      notes.push(
        `Arbitrage: ${pairs} buy/sell slot pair(s) accepted — spread beats fees + losses + ${k.min_buy_saving_sek_per_kwh} SEK/kWh margin`
      );
    }
  }

  // ---- Merge windows (after all passes so arbitrage sells merge in too) ----
  const { windows: sellWindows, droppedShort } = mergeAcceptedSlots(
    slots,
    acceptedSell,
    sellW,
    "sell",
    k.min_window_minutes
  );
  if (droppedShort) {
    notes.push(`Dropped ${droppedShort} sell window(s) shorter than ${k.min_window_minutes} min`);
    for (const i of acceptedSell) {
      if (!sellWindows.some(w => w.slotIndexes.includes(i))) sellW[i] = 0;
    }
    current = simulate(input, slots, sellW, buyW, tailSpot);
  }

  const { windows: buyWindows } = mergeAcceptedSlots(slots, acceptedBuy, buyW, "buy", k.min_window_minutes);

  // ---- Package result ----
  const spotsAll = pricedSlots.map(s => s.spot!).sort((a, b) => a - b);
  const percentileOf = (v: number) => Math.round((spotsAll.filter(x => x <= v).length / spotsAll.length) * 100);

  const toPlanned = (w: MergedWindow): PlannedWindow => {
    const spots = w.slotIndexes.map(i => slots[i].spot!).filter(v => v !== undefined);
    const avgSpot = spots.reduce((a, b) => a + b, 0) / Math.max(spots.length, 1);
    const socBefore = current.socAfterSlot[Math.max(0, w.slotIndexes[0] - 1)] ?? (input.socPercent / 100) * cap;
    const socAfter = current.socAfterSlot[w.slotIndexes[w.slotIndexes.length - 1]];
    let expectedKwh: number;
    if (w.kind === "sell") {
      expectedKwh = w.slotIndexes.reduce((sum, i) => {
        const s = slots[i];
        const exportW = Math.max(0, Math.min(w.watts, k.inverter_max_ac_output_watts - s.houseW));
        return sum + (exportW * s.durationH) / 1000;
      }, 0);
    } else {
      expectedKwh = w.slotIndexes.reduce((sum, i) => sum + (w.watts * slots[i].durationH) / 1000, 0);
    }
    const isArbitrage = w.kind === "buy" && w.slotIndexes.some(i => arbitrageBuySlots.has(i));
    const reason =
      w.kind === "sell"
        ? `spot avg ${avgSpot.toFixed(2)} SEK/kWh (P${percentileOf(avgSpot)} of horizon), ~${expectedKwh.toFixed(0)} kWh, SOC ${Math.round((socBefore / cap) * 100)}%→${Math.round((socAfter / cap) * 100)}%`
        : isArbitrage
          ? `arbitrage: buying ~${expectedKwh.toFixed(0)} kWh at ${avgSpot.toFixed(2)} SEK/kWh (P${percentileOf(avgSpot)}) to re-sell at the later price peak`
          : `cheap spot avg ${avgSpot.toFixed(2)} SEK/kWh (P${percentileOf(avgSpot)}), pre-buying ~${expectedKwh.toFixed(0)} kWh to avoid pricier unavoidable import`;
    return { startMs: w.startMs, endMs: w.endMs, watts: w.watts, kind: w.kind, reason, expectedKwh, avgSpot };
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
  if (k.extra_reserve_kwh > 0) notes.push(`User extra reserve of ${k.extra_reserve_kwh} kWh respected`);

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
  const pricedSlots = slots.filter(s => s.spot !== undefined);
  const lastDaySpots = pricedSlots
    .slice(-96)
    .map(s => s.spot!)
    .sort((a, b) => a - b);
  const tailSpot = lastDaySpots[Math.floor(lastDaySpots.length / 2)] ?? 0.5;
  const r = simulate(input, slots, new Array(slots.length).fill(0), new Array(slots.length).fill(0), tailSpot);
  return {
    violationWh: r.violationWh,
    minSocPercent: Math.round((r.minSocWh / input.capacityWh) * 1000) / 10,
    minSocAt: new Date(r.minSocMs).toISOString(),
    unavoidableImportKwh: Math.round(r.importWh / 100) / 10,
    endSocPercent: Math.round((r.endSocWh / input.capacityWh) * 1000) / 10,
    revenueSek: Math.round(r.revenueSek * 10) / 10,
  };
}

function windowPowerAt(windows: FixedWindow[], startMs: number, endMs: number): number {
  let max = 0;
  for (const w of windows) {
    if (w.startMs < endMs && w.endMs > startMs) max = Math.max(max, w.watts);
  }
  return max;
}

function buildSlots(input: PlannerInput): Slot[] {
  const { prices, nowMs, constraintTailHours, houseLoadWattsAt, fixedSells, fixedBuys } = input;
  const slots: Slot[] = [];
  const relevantPrices = prices.filter(p => p.startMs + SLOT_MS > nowMs).sort((a, b) => a.startMs - b.startMs);
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

  for (const p of relevantPrices) pushSlot(p.startMs, p.spot);
  for (let t = pricedEndMs; t < tailEndMs; t += SLOT_MS) pushSlot(t, undefined);
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
