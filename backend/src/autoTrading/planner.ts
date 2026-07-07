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
 * using solar + consumption forecasts, then greedily allocate 15-min sell slots from the highest spot price
 * down, keeping every accepted plan feasible (SOC never below the planner floor + user reserve). Selling
 * energy the battery couldn't have absorbed anyway (would have auto-exported when full) is naturally handled
 * by the simulation's revenue accounting.
 *
 * Two forces keep the schedule contiguous: every sell-run start is charged sell_restart_penalty_sek in the
 * simulation, and a consolidation pass (see consolidateSellSlots) defragments what the greedy scattered.
 * The reserve floor relaxes to planner_soc_floor_sunny_percent in slots where forecast PV covers the house.
 */

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
  const floorPlannerWh = (k.planner_soc_floor_percent / 100) * cap + k.extra_reserve_kwh * 1000;
  // While forecast PV covers the house, a forecast miss costs minutes of import instead of a
  // stranded night — the reserve requirement drops accordingly (never above the normal floor).
  const floorSunnyWh = Math.min(
    (k.planner_soc_floor_sunny_percent / 100) * cap + k.extra_reserve_kwh * 1000,
    floorPlannerWh
  );
  const floorRuntimeWh = (k.runtime_soc_floor_percent / 100) * cap;
  const floorEmergencyWh = (k.emergency_soc_floor_percent / 100) * cap;

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
  // so the first sell_ramp_minutes of every (re)start deliver reduced power.
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
      // Starting a feed-in run costs more than the modeled ramp: inverter mode/relay churn,
      // and schedules full of holes that nobody asked for. Charge each run start for it.
      if (sellRunMinutes === 0) revenueSek -= k.sell_restart_penalty_sek;
      // Export is limited by what battery + PV can physically supply beyond the house
      // House has first dibs on the inverter's AC output; export gets the rest of the 15 kW rating
      exportW = Math.min(sellSetW, k.inverter_max_ac_output_watts - s.houseW);
      exportW = Math.max(exportW, 0);
      // Average ramp factor over this slot: linear 0→100% across the first sell_ramp_minutes of the run
      const rampMin = k.sell_ramp_minutes;
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
        exportW = k.baseline_feed_watts;
      }
    }

    let netBattW: number;
    if (gridChargeW > 0) {
      netBattW = s.pvW + gridChargeW;
    } else {
      netBattW = s.pvW - s.houseW - parasiticW - exportW;
    }
    const deltaWh =
      netBattW >= 0 ? netBattW * k.charge_efficiency * s.durationH : (netBattW / k.discharge_efficiency) * s.durationH;
    socWh += deltaWh;

    if (socWh > cap) {
      // Battery full: surplus PV flows to the grid by itself (solar-mode feeding)
      const overflowInBatteryWh = socWh - cap;
      autoExportWh += overflowInBatteryWh / k.charge_efficiency;
      revenueSek += (overflowInBatteryWh / k.charge_efficiency / 1000) * (spot + k.sell_bonus_sek_per_kwh);
      socWh = cap;
    }
    if (socWh < floorEmergencyWh) {
      // Battery can't go lower — the house pulls the deficit from the grid (unavoidable import)
      const deficitWh = floorEmergencyWh - socWh;
      const importedForHouseWh = deficitWh * k.discharge_efficiency;
      slotImportWh += importedForHouseWh;
      socWh = floorEmergencyWh;
    }

    const exportedWh = exportW * s.durationH;
    sellExportWh += sellSetW > 0 ? exportedWh : 0;
    revenueSek += (exportedWh / 1000) * (spot + k.sell_bonus_sek_per_kwh);
    importWh += slotImportWh;
    revenueSek -= (slotImportWh / 1000) * (spot + k.buy_surcharges_sek_per_kwh) * k.vat_multiplier;

    const floorWh = s.pvW > s.houseW + parasiticW ? floorSunnyWh : floorPlannerWh;
    if (socWh < floorWh) violationWh += floorWh - socWh;
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
  const windows: MergedWindow[] = [];
  for (const i of sorted) {
    const last = windows[windows.length - 1];
    if (last && slots[i].startMs === last.endMs && wattsBySlot[i] === last.watts) {
      last.endMs = slots[i].endMs;
      last.slotIndexes.push(i);
    } else {
      windows.push({ startMs: slots[i].startMs, endMs: slots[i].endMs, watts: wattsBySlot[i], kind, slotIndexes: [i] });
    }
  }
  // A power step mid-run splits into adjacent windows that are still one continuous feed —
  // the minimum-length rule judges the whole contiguous chain, not each window.
  const chains: MergedWindow[][] = [];
  for (const w of windows) {
    const lastChain = chains[chains.length - 1];
    if (lastChain && lastChain[lastChain.length - 1].endMs === w.startMs) lastChain.push(w);
    else chains.push([w]);
  }
  const kept: MergedWindow[] = [];
  let droppedShort = 0;
  for (const chain of chains) {
    const chainMinutes = (chain[chain.length - 1].endMs - chain[0].startMs) / 60000;
    if (chainMinutes >= min_window_minutes) kept.push(...chain);
    else droppedShort += chain.length;
  }
  return { windows: kept, droppedShort };
}

/**
 * Defragment the greedy's sell allocation. Under a binding reserve budget the greedy takes the
 * top-priced 15-min slots, which zigzagging 15-min prices scatter into combs — and the ramp model
 * amplifies that: near budget exhaustion a full-power contiguous slot no longer fits while an
 * isolated (ramp-crippled, ~2/3 energy) slot still does, so holes win systematically. Local-search
 * moves repair this, each re-simulated and only applied when feasible and simulated revenue
 * improves (the restart penalty is what tips consolidation into "improves"):
 *   - fill a one-slot hole between runs, alone (full or reduced power) or funded by dropping the
 *     cheapest edge slot of another run
 *   - merge two neighbouring runs by relocating the smaller flush against the larger (covers
 *     single-slot teeth as the degenerate case) — öre of price cost against whole SEK of penalty
 *   - extend a run edge at reduced power, so a fractional leftover budget still gets sold instead
 *     of spawning a remote ramp-crippled tooth (pure adds must clear min_gain_sek_per_slot and the
 *     min sell spot, like the greedy's adds)
 * Mutates sellW in place; returns the simulation state it converged on.
 */
function consolidateSellSlots(
  input: PlannerInput,
  slots: Slot[],
  sellW: number[],
  buyW: number[],
  tailSpot: number,
  feasible: (r: SimResult) => boolean,
  current: SimResult
): SimResult {
  const k = input.knobs;
  const fillable = (j: number) =>
    j >= 0 &&
    j < slots.length &&
    sellW[j] === 0 &&
    buyW[j] === 0 &&
    slots[j].spot !== undefined &&
    slots[j].fixedSellW === 0 &&
    slots[j].fixedBuyW === 0 &&
    !input.sellVetoWindows.some(v => v.startMs < slots[j].endMs && v.endMs > slots[j].startMs);
  const timeAdjacent = (i: number, j: number) =>
    slots[i] !== undefined && slots[j] !== undefined && slots[j].startMs === slots[i].endMs;

  const computeRuns = () => {
    const runs: number[][] = [];
    for (let i = 0; i < slots.length; i++) {
      if (sellW[i] <= 0) continue;
      const lastRun = runs[runs.length - 1];
      const prev = lastRun?.[lastRun.length - 1];
      if (prev !== undefined && timeAdjacent(prev, i)) lastRun.push(i);
      else runs.push([i]);
    }
    return runs;
  };

  let trialsLeft = 400;
  const accept = (minGainSek: number): boolean => {
    if (trialsLeft-- <= 0) return false;
    const trial = simulate(input, slots, sellW, buyW, tailSpot);
    if (feasible(trial) && trial.revenueSek > current.revenueSek + Math.max(minGainSek, 1e-6)) {
      current = trial;
      return true;
    }
    return false;
  };

  // Add one slot (full power first, reduced captures fractional budgets), optionally funded by
  // dropping another. Funded moves are ~energy-neutral and need no extra gain; pure adds clear
  // the same min-gain bar as the greedy's.
  const tryFill = (dropIdx: number | undefined, addIdx: number): boolean => {
    const savedDrop = dropIdx !== undefined ? sellW[dropIdx] : 0;
    if (dropIdx !== undefined) sellW[dropIdx] = 0;
    for (const factor of [1, 2 / 3, 1 / 2, 1 / 3]) {
      sellW[addIdx] = Math.round(k.max_sell_power_watts * factor);
      if (accept(dropIdx === undefined ? k.min_gain_sek_per_slot : 0)) return true;
    }
    sellW[addIdx] = 0;
    if (dropIdx !== undefined) sellW[dropIdx] = savedDrop;
    return false;
  };

  // Relocate a whole run onto a target position. The move changes ramp state (e.g. a crippled
  // isolated slot becomes a full-power run member), so scaled-down watts are also tried — that
  // lets an energy-equivalent relocation through a binding budget.
  const tryRelocateRun = (run: number[], targets: number[]): boolean => {
    const savedWatts = run.map(i => sellW[i]);
    for (const i of run) sellW[i] = 0;
    if (targets.every(fillable)) {
      for (const factor of [1, 2 / 3, 1 / 2, 1 / 3]) {
        targets.forEach((j, idx) => (sellW[j] = Math.round(savedWatts[idx] * factor)));
        if (accept(0)) return true;
      }
      for (const j of targets) sellW[j] = 0;
    }
    run.forEach((i, idx) => (sellW[i] = savedWatts[idx]));
    return false;
  };

  let movesLeft = 24;
  outer: while (movesLeft-- > 0 && trialsLeft > 0) {
    const runs = computeRuns();
    if (!runs.length) break;

    // 1. One-slot holes between consecutive runs: fill, else fund by dropping the cheapest edge
    //    slot of some run (never a slot adjacent to the hole — that just moves it)
    const edges = runs
      .flatMap(run => (run.length === 1 ? [run[0]] : [run[0], run[run.length - 1]]))
      .sort((a, b) => (slots[a].spot ?? 0) - (slots[b].spot ?? 0));
    for (let runIdx = 0; runIdx + 1 < runs.length; runIdx++) {
      const hole = runs[runIdx][runs[runIdx].length - 1] + 1;
      if (runs[runIdx + 1][0] !== hole + 1 || !fillable(hole)) continue;
      if (!timeAdjacent(hole - 1, hole) || !timeAdjacent(hole, hole + 1)) continue;
      if (tryFill(undefined, hole)) continue outer;
      for (const edge of edges) {
        if (Math.abs(edge - hole) <= 1) continue;
        if (tryFill(edge, hole)) continue outer;
      }
    }

    // 2. Merge neighbouring runs by relocating one flush against the other. Try the cheaper
    //    relocation (fewer slots moved) first, then the reverse.
    for (let runIdx = 0; runIdx + 1 < runs.length; runIdx++) {
      const before = runs[runIdx];
      const after = runs[runIdx + 1];
      if (after[0] - before[before.length - 1] < 2) continue;
      // A run relocated flush against the other: target indexes + the anchor slot they must touch
      const flushRight = (moved: number[]) => ({
        moved,
        targets: moved.map((_, idx) => after[0] - moved.length + idx),
        anchor: after[0],
      });
      const flushLeft = (moved: number[]) => ({
        moved,
        targets: moved.map((_, idx) => before[before.length - 1] + 1 + idx),
        anchor: before[before.length - 1],
      });
      const attempts =
        before.length <= after.length ? [flushRight(before), flushLeft(after)] : [flushLeft(after), flushRight(before)];
      for (const { moved, targets, anchor } of attempts) {
        const chain = [...targets, anchor].sort((a, b) => a - b);
        if (!chain.every((idx, pos) => pos === 0 || timeAdjacent(chain[pos - 1], idx))) continue;
        if (tryRelocateRun(moved, targets)) continue outer;
      }
    }

    // 3. Extend run edges at reduced power — mops up a leftover budget fraction
    for (const run of runs) {
      const first = run[0];
      const last = run[run.length - 1];
      for (const target of [first - 1, last + 1]) {
        if (!fillable(target)) continue;
        if (!(target < first ? timeAdjacent(target, first) : timeAdjacent(last, target))) continue;
        if ((slots[target].spot ?? 0) < k.min_sell_spot_sek_per_kwh) continue;
        if (tryFill(undefined, target)) continue outer;
      }
    }
    break;
  }

  // Finally, equalize power across each chain's post-ramp body: same energy (mean rounded down),
  // ± öre of revenue, and the schedule collapses to a couple of entries instead of the power
  // staircase reduced-power fills leave behind. Slots still inside the ramp window keep their
  // power — the ramp caps their export, so averaging power away from them loses real energy.
  for (const run of computeRuns()) {
    let offsetMinutes = 0;
    const body: number[] = [];
    for (const i of run) {
      if (offsetMinutes >= k.sell_ramp_minutes) body.push(i);
      offsetMinutes += slots[i].durationH * 60;
    }
    if (body.length < 2 || new Set(body.map(i => sellW[i])).size <= 1) continue;
    if (trialsLeft-- <= 0) break;
    const savedWatts = body.map(i => sellW[i]);
    const meanWatts = Math.floor(savedWatts.reduce((a, b) => a + b, 0) / body.length / 100) * 100;
    for (const i of body) sellW[i] = meanWatts;
    const trial = simulate(input, slots, sellW, buyW, tailSpot);
    if (feasible(trial) && trial.revenueSek >= current.revenueSek - 0.1 * body.length) {
      current = trial;
    } else {
      body.forEach((i, idx) => (sellW[i] = savedWatts[idx]));
    }
  }
  return current;
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
        s.spot >= k.min_sell_spot_sek_per_kwh &&
        s.fixedSellW === 0 &&
        s.fixedBuyW === 0 &&
        !overlapsVeto(s, input.sellVetoWindows)
    )
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
        const s = slots[j];
        if (
          sellW[j] > 0 ||
          s.spot === undefined ||
          s.fixedSellW > 0 ||
          s.fixedBuyW > 0 ||
          overlapsVeto(s, input.sellVetoWindows)
        ) {
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

  // Defragment what the greedy scattered (see consolidateSellSlots) — sellW is the source of
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
