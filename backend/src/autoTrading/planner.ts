/**
 * Pure day-ahead trading planner. No IO, no reading of the clock — everything comes in via PlannerInput,
 * so it can be simulated/tested standalone.
 *
 * Economics (E.ON, SE3, 2026): buying costs ≈ (spot + ~1.19 SEK surcharges) × 1.25 VAT ≈ 1.25×spot + 1.48 SEK/kWh,
 * selling earns ≈ spot + ~0.09 SEK/kWh. Buying is therefore only ever scheduled to avoid an even more
 * expensive unavoidable import (battery empty → house pulls from grid), never for arbitrage.
 *
 * Strategy: simulate battery SOC over the price horizon (+ a constraint tail covering the following night)
 * using solar + consumption forecasts, then greedily allocate 15-min sell slots from the highest spot price
 * down, keeping every accepted plan feasible (SOC never below the planner floor + user reserve). Selling
 * energy the battery couldn't have absorbed anyway (would have auto-exported when full) is naturally handled
 * by the simulation's revenue accounting.
 */

export const SLOT_MS = 15 * 60 * 1000;

export type PriceSlot15 = { startMs: number; spot: number };

export type FixedWindow = { startMs: number; endMs: number; watts: number };

export type PlannerKnobs = {
  maxSellPowerWatts: number;
  batteryMaxDischargeWatts: number;
  maxBuyPowerWatts: number;
  plannerSocFloorPercent: number;
  runtimeSocFloorPercent: number;
  emergencySocFloorPercent: number;
  extraReserveKwh: number;
  minSellSpotSekPerKwh: number;
  minGainSekPerSlot: number;
  minWindowMinutes: number;
  chargeEfficiency: number;
  dischargeEfficiency: number;
  buySurchargesSekPerKwh: number;
  vatMultiplier: number;
  sellBonusSekPerKwh: number;
  minBuySavingSekPerKwh: number;
  baselineFeedWatts: number;
  /** The inverter ramps grid feed-in slowly (grid safety) — minutes from 0 to full export power */
  sellRampMinutes: number;
  /** Also buy purely to re-sell later when the spread beats fees + losses + margin */
  allowArbitrageBuying: boolean;
};

export type PlannerInput = {
  nowMs: number;
  /** Sorted, contiguous 15-min spot price slots (today + tomorrow when available). May include past slots. */
  prices: PriceSlot15[];
  /** Solar production forecast in watts at a given time. Must cover the price horizon plus the constraint tail. */
  solarWattsAt: (ms: number) => number;
  /** House consumption forecast (AC output) in watts, excluding inverter parasitic draw. */
  houseLoadWattsAt: (ms: number) => number;
  parasiticWatts: number;
  socPercent: number;
  capacityWh: number;
  /** Hours past the end of price data to keep enforcing SOC constraints (covers the night after the last priced day). */
  constraintTailHours: number;
  /** Schedule windows owned by the user — treated as immutable and simulated as given. */
  fixedSells: FixedWindow[];
  fixedBuys: FixedWindow[];
  /** Time ranges where the user deleted an auto-created window — the planner must not re-add there. */
  sellVetoWindows: { startMs: number; endMs: number }[];
  buyVetoWindows: { startMs: number; endMs: number }[];
  knobs: PlannerKnobs;
};

export type PlannedWindow = {
  startMs: number;
  endMs: number;
  watts: number;
  kind: "sell" | "buy";
  reason: string;
  expectedKwh: number;
  avgSpot: number;
};

export type PlanProjection = {
  startSocPercent: number;
  minSocPercent: number;
  minSocAt: string;
  endSocPercent: number;
  plannedSellKwh: number;
  autoExportKwh: number;
  unavoidableImportKwh: number;
  plannedBuyKwh: number;
  estimatedRevenueSek: number;
  baselineRevenueSek: number;
};

export type PlanResult = {
  sells: PlannedWindow[];
  buys: PlannedWindow[];
  notes: string[];
  projection: PlanProjection;
};

type Slot = {
  startMs: number;
  endMs: number;
  durationH: number;
  spot: number | undefined;
  pvW: number;
  houseW: number;
  fixedSellW: number;
  fixedBuyW: number;
};

type SimResult = {
  revenueSek: number;
  violationWh: number;
  minSocWh: number;
  minSocMs: number;
  endSocWh: number;
  sellExportWh: number;
  autoExportWh: number;
  importWh: number;
  boughtWh: number;
  socAfterSlot: number[];
};

function windowPowerAt(windows: FixedWindow[], startMs: number, endMs: number): number {
  let max = 0;
  for (const w of windows) {
    if (w.startMs < endMs && w.endMs > startMs) max = Math.max(max, w.watts);
  }
  return max;
}

function buildSlots(input: PlannerInput): Slot[] {
  const { prices, nowMs, constraintTailHours, solarWattsAt, houseLoadWattsAt, fixedSells, fixedBuys } = input;
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

function simulate(input: PlannerInput, slots: Slot[], sellW: number[], buyW: number[], tailSpot: number): SimResult {
  const k = input.knobs;
  const cap = input.capacityWh;
  const floorPlannerWh = (k.plannerSocFloorPercent / 100) * cap + k.extraReserveKwh * 1000;
  const floorRuntimeWh = (k.runtimeSocFloorPercent / 100) * cap;
  const floorEmergencyWh = (k.emergencySocFloorPercent / 100) * cap;

  let socWh = (input.socPercent / 100) * cap;
  let revenueSek = 0;
  let violationWh = 0;
  let minSocWh = socWh;
  let minSocMs = input.nowMs;
  let sellExportWh = 0;
  let autoExportWh = 0;
  let importWh = 0;
  let boughtWh = 0;
  const socAfterSlot: number[] = new Array(slots.length);
  // Minutes of continuous selling so far — the inverter ramps grid feed-in slowly (grid safety),
  // so the first sellRampMinutes of every (re)start deliver reduced power.
  let sellRunMinutes = 0;

  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    const spot = s.spot ?? tailSpot;
    const parasiticW = input.parasiticWatts;
    const sellSetW = Math.max(sellW[i], s.fixedSellW);
    const requestedBuyW = Math.max(buyW[i], s.fixedBuyW);
    // Runtime never does both at once (feedWhenNoSolar errors out) — selling wins in our model
    const buySetW = sellSetW > 0 ? 0 : requestedBuyW;

    let exportW = 0;
    let gridChargeW = 0;
    let slotImportWh = 0;

    if (buySetW > 0 && socWh < cap * 0.98) {
      // AC charging: battery charges from grid, house is fed from grid too
      gridChargeW = buySetW;
      slotImportWh +=
        (buySetW + s.houseW + parasiticW - Math.min(s.pvW, buySetW + s.houseW + parasiticW)) * s.durationH;
      boughtWh += buySetW * s.durationH;
    }

    const sellingThisSlot = sellSetW > 0 && socWh > floorRuntimeWh;
    if (sellingThisSlot) {
      // Export is limited by what battery + PV can physically supply beyond the house
      exportW = Math.min(sellSetW, k.batteryMaxDischargeWatts + s.pvW - s.houseW - parasiticW);
      exportW = Math.max(exportW, 0);
      // Average ramp factor over this slot: linear 0→100% across the first sellRampMinutes of the run
      const rampMin = k.sellRampMinutes;
      if (rampMin > 0 && sellRunMinutes < rampMin) {
        const slotMin = s.durationH * 60;
        const e0 = sellRunMinutes;
        const e1 = e0 + slotMin;
        const rampedUntil = Math.min(e1, rampMin);
        const avgFactor =
          ((rampedUntil * rampedUntil - e0 * e0) / (2 * rampMin) + Math.max(0, e1 - rampedUntil)) / slotMin;
        exportW *= avgFactor;
      }
      sellRunMinutes += s.durationH * 60;
    } else {
      sellRunMinutes = 0;
      if (buySetW === 0 && s.pvW < s.houseW + parasiticW + 380) {
        // Baseline "feed when no solar" that nets out the inverter's constant grid draw
        exportW = k.baselineFeedWatts;
      }
    }

    let netBattW: number;
    if (gridChargeW > 0) {
      netBattW = s.pvW + gridChargeW;
    } else {
      netBattW = s.pvW - s.houseW - parasiticW - exportW;
    }
    const deltaWh =
      netBattW >= 0 ? netBattW * k.chargeEfficiency * s.durationH : (netBattW / k.dischargeEfficiency) * s.durationH;
    socWh += deltaWh;

    if (socWh > cap) {
      // Battery full: surplus PV flows to the grid by itself (solar-mode feeding)
      const overflowInBatteryWh = socWh - cap;
      autoExportWh += overflowInBatteryWh / k.chargeEfficiency;
      revenueSek += (overflowInBatteryWh / k.chargeEfficiency / 1000) * (spot + k.sellBonusSekPerKwh);
      socWh = cap;
    }
    if (socWh < floorEmergencyWh) {
      // Battery can't go lower — the house pulls the deficit from the grid (unavoidable import)
      const deficitWh = floorEmergencyWh - socWh;
      const importedForHouseWh = deficitWh * k.dischargeEfficiency;
      slotImportWh += importedForHouseWh;
      socWh = floorEmergencyWh;
    }

    const exportedWh = exportW * s.durationH;
    sellExportWh += sellSetW > 0 ? exportedWh : 0;
    revenueSek += (exportedWh / 1000) * (spot + k.sellBonusSekPerKwh);
    importWh += slotImportWh;
    revenueSek -= (slotImportWh / 1000) * (spot + k.buySurchargesSekPerKwh) * k.vatMultiplier;

    if (socWh < floorPlannerWh) violationWh += floorPlannerWh - socWh;
    if (socWh < minSocWh) {
      minSocWh = socWh;
      minSocMs = s.endMs;
    }
    socAfterSlot[i] = socWh;
  }

  return {
    revenueSek,
    violationWh,
    minSocWh,
    minSocMs,
    endSocWh: socWh,
    sellExportWh,
    autoExportWh,
    importWh,
    boughtWh,
    socAfterSlot,
  };
}

function mergeAcceptedSlots(
  slots: Slot[],
  accepted: number[],
  watts: number,
  kind: "sell" | "buy",
  minWindowMinutes: number
): {
  windows: { startMs: number; endMs: number; watts: number; kind: "sell" | "buy"; slotIndexes: number[] }[];
  droppedShort: number;
} {
  const sorted = [...accepted].sort((a, b) => a - b);
  const windows: { startMs: number; endMs: number; watts: number; kind: "sell" | "buy"; slotIndexes: number[] }[] = [];
  for (const i of sorted) {
    const last = windows[windows.length - 1];
    if (last && slots[i].startMs === last.endMs) {
      last.endMs = slots[i].endMs;
      last.slotIndexes.push(i);
    } else {
      windows.push({ startMs: slots[i].startMs, endMs: slots[i].endMs, watts, kind, slotIndexes: [i] });
    }
  }
  const before = windows.length;
  const kept = windows.filter(w => (w.endMs - w.startMs) / 60000 >= minWindowMinutes);
  return { windows: kept, droppedShort: before - kept.length };
}

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
  const overlapsVeto = (s: Slot, vetoes: { startMs: number; endMs: number }[]) =>
    vetoes.some(v => v.startMs < s.endMs && v.endMs > s.startMs);
  const sellCandidates = slots
    .map((s, i) => ({ s, i }))
    .filter(
      ({ s }) =>
        s.spot !== undefined &&
        s.spot >= k.minSellSpotSekPerKwh &&
        s.fixedSellW === 0 &&
        s.fixedBuyW === 0 &&
        !overlapsVeto(s, input.sellVetoWindows)
    )
    .sort((a, b) => b.s.spot! - a.s.spot!);

  let current = base;
  const acceptedSell: number[] = [];
  for (const { i } of sellCandidates) {
    sellW[i] = k.maxSellPowerWatts;
    const trial = simulate(input, slots, sellW, buyW, tailSpot);
    const gain = trial.revenueSek - current.revenueSek;
    if (feasibleVsBase(trial) && gain >= k.minGainSekPerSlot) {
      current = trial;
      acceptedSell.push(i);
    } else {
      sellW[i] = 0;
    }
  }

  // Fill single-slot gaps between accepted slots: a 15-min feed stop/start costs inverter
  // rampup + USB command churn, so accept a small revenue loss for a contiguous window.
  const acceptedSet = new Set(acceptedSell);
  const maxSmoothingLossSek = 1;
  for (let i = 1; i < slots.length - 1; i++) {
    if (sellW[i] > 0 || slots[i].spot === undefined) continue;
    if (!acceptedSet.has(i - 1) || !acceptedSet.has(i + 1)) continue;
    if (slots[i - 1].endMs !== slots[i].startMs || slots[i].endMs !== slots[i + 1].startMs) continue;
    if (slots[i].fixedSellW > 0 || slots[i].fixedBuyW > 0 || overlapsVeto(slots[i], input.sellVetoWindows)) continue;
    sellW[i] = k.maxSellPowerWatts;
    const trial = simulate(input, slots, sellW, buyW, tailSpot);
    if (feasibleVsBase(trial) && trial.revenueSek - current.revenueSek >= -maxSmoothingLossSek) {
      current = trial;
      acceptedSell.push(i);
      acceptedSet.add(i);
    } else {
      sellW[i] = 0;
    }
  }

  // ---- Buy allocation, pass 1: avert projected unavoidable imports, cheapest slots first ----
  const acceptedBuy: number[] = [];
  if (current.importWh > 500 && k.maxBuyPowerWatts > 0) {
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
      buyW[i] = k.maxBuyPowerWatts;
      const trial = simulate(input, slots, sellW, buyW, tailSpot);
      const gain = trial.revenueSek - current.revenueSek;
      const extraBoughtKwh = (trial.boughtWh - current.boughtWh) / 1000;
      if (feasibleVsBase(trial) && extraBoughtKwh > 0 && gain / extraBoughtKwh >= k.minBuySavingSekPerKwh) {
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
  if (k.allowArbitrageBuying && k.maxBuyPowerWatts > 0) {
    const roundTrip = k.chargeEfficiency * k.dischargeEfficiency;
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
    const buySlotKwh = (k.maxBuyPowerWatts * 0.25) / 1000;
    const sellSlotKwh = (Math.min(k.maxSellPowerWatts, k.batteryMaxDischargeWatts) * 0.25) / 1000;
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
            s.spot! >= k.minSellSpotSekPerKwh &&
            !overlapsVeto(s, input.sellVetoWindows)
        )
        .sort((a, b2) => b2.s.spot! - a.s.spot!);
      if (!sellPool.length) break;
      // Even the best possible pairing must clear the margin on prices alone, else nothing can
      const avgBuySpot = buyGroup.reduce((sum, i) => sum + slots[i].spot!, 0) / buyGroup.length;
      const bestPossible =
        (sellPool[0].s.spot! + k.sellBonusSekPerKwh) * roundTrip -
        (avgBuySpot + k.buySurchargesSekPerKwh) * k.vatMultiplier;
      if (bestPossible < k.minBuySavingSekPerKwh) break;
      let matched = false;
      for (const { i: sellIdx } of sellPool.slice(0, 3)) {
        for (const b of buyGroup) buyW[b] = k.maxBuyPowerWatts;
        sellW[sellIdx] = k.maxSellPowerWatts;
        const trial = simulate(input, slots, sellW, buyW, tailSpot);
        const gain = trial.revenueSek - current.revenueSek;
        const extraBoughtKwh = (trial.boughtWh - current.boughtWh) / 1000;
        if (feasibleVsBase(trial) && extraBoughtKwh > 0.1 && gain / extraBoughtKwh >= k.minBuySavingSekPerKwh) {
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
        `Arbitrage: ${pairs} buy/sell slot pair(s) accepted — spread beats fees + losses + ${k.minBuySavingSekPerKwh} SEK/kWh margin`
      );
    }
  }

  // ---- Merge windows (after all passes so arbitrage sells merge in too) ----
  const { windows: sellWindows, droppedShort } = mergeAcceptedSlots(
    slots,
    acceptedSell,
    k.maxSellPowerWatts,
    "sell",
    k.minWindowMinutes
  );
  if (droppedShort) {
    notes.push(`Dropped ${droppedShort} sell window(s) shorter than ${k.minWindowMinutes} min`);
    for (const i of acceptedSell) {
      if (!sellWindows.some(w => w.slotIndexes.includes(i))) sellW[i] = 0;
    }
    current = simulate(input, slots, sellW, buyW, tailSpot);
  }

  const { windows: buyWindows } = mergeAcceptedSlots(slots, acceptedBuy, k.maxBuyPowerWatts, "buy", k.minWindowMinutes);

  // ---- Package result ----
  const spotsAll = pricedSlots.map(s => s.spot!).sort((a, b) => a - b);
  const percentileOf = (v: number) => Math.round((spotsAll.filter(x => x <= v).length / spotsAll.length) * 100);

  const toPlanned = (w: {
    startMs: number;
    endMs: number;
    watts: number;
    kind: "sell" | "buy";
    slotIndexes: number[];
  }): PlannedWindow => {
    const spots = w.slotIndexes.map(i => slots[i].spot!).filter(v => v !== undefined);
    const avgSpot = spots.reduce((a, b) => a + b, 0) / Math.max(spots.length, 1);
    const socBefore = current.socAfterSlot[Math.max(0, w.slotIndexes[0] - 1)] ?? (input.socPercent / 100) * cap;
    const socAfter = current.socAfterSlot[w.slotIndexes[w.slotIndexes.length - 1]];
    let expectedKwh: number;
    if (w.kind === "sell") {
      expectedKwh = w.slotIndexes.reduce((sum, i) => {
        const s = slots[i];
        const exportW = Math.max(
          0,
          Math.min(w.watts, k.batteryMaxDischargeWatts + s.pvW - s.houseW - input.parasiticWatts)
        );
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
  if (k.extraReserveKwh > 0) notes.push(`User extra reserve of ${k.extraReserveKwh} kWh respected`);

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

  return { sells, buys, notes, projection };
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
  };
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
