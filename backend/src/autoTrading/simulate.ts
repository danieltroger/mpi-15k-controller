/**
 * The planner's battery/revenue simulation core: replay a candidate schedule (per-slot sell/buy
 * setpoints + fixed windows) over the forecast horizon and report revenue, floor violations and
 * the SOC trajectory. Shared by the greedy allocation in planner.ts and the local search in
 * sellConsolidation.ts, which is why it lives in its own module.
 */

import type { PlannerInput, PlannerKnobs, SimResult, Slot } from "./planner.types.ts";

export function simulate(
  input: PlannerInput,
  slots: Slot[],
  sellW: number[],
  buyW: number[],
  tailSpot: number
): SimResult {
  const knobs = input.knobs;
  const cap = input.capacityWh;
  const floorPlannerWh = (knobs.planner_soc_floor_percent / 100) * cap + knobs.extra_reserve_kwh * 1000;
  // While forecast PV covers the house, a forecast miss costs minutes of import instead of a
  // stranded night — the reserve requirement drops accordingly (never above the normal floor).
  const floorSunnyWh = Math.min(
    (knobs.planner_soc_floor_sunny_percent / 100) * cap + knobs.extra_reserve_kwh * 1000,
    floorPlannerWh
  );
  const floorRuntimeWh = (knobs.runtime_soc_floor_percent / 100) * cap;
  const floorEmergencyWh = (knobs.emergency_soc_floor_percent / 100) * cap;

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
  const autoExportWPerSlot: number[] = new Array(slots.length).fill(0);
  // The export level the feed-in had reached when the previous slot ended. The inverter ramps grid
  // feed-in up at a fixed rate (grid safety), on a start and on a mid-run setpoint step-up alike,
  // and drops it at once (see rampedSlotExport)
  let reachedExportW = 0;
  const rampWattsPerMinute = sellRampWattsPerMinute(knobs);

  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    const spot = slot.spot ?? tailSpot;
    const parasiticW = input.parasiticWatts;
    const sellSetW = Math.max(sellW[i], slot.fixedSellW);
    const requestedBuyW = Math.max(buyW[i], slot.fixedBuyW);
    // Runtime never does both at once (feedWhenNoSolar errors out) — selling wins in our model
    const buySetW = sellSetW > 0 ? 0 : requestedBuyW;

    let exportW = 0;
    let gridChargeW = 0;
    let slotImportWh = 0;

    if (buySetW > 0 && socWh < cap * 0.98) {
      // AC charging: battery charges from grid, house is fed from grid too
      gridChargeW = buySetW;
      slotImportWh +=
        (buySetW + slot.houseW + parasiticW - Math.min(slot.pvW, buySetW + slot.houseW + parasiticW)) * slot.durationH;
      boughtWh += buySetW * slot.durationH;
    }

    const sellingThisSlot = sellSetW > 0 && socWh > floorRuntimeWh;
    if (sellingThisSlot) {
      // Export is limited by what battery + PV can physically supply beyond the house
      // House has first dibs on the inverter's AC output; export gets the rest of the 15 kW rating
      const targetExportW = Math.max(0, Math.min(sellSetW, knobs.inverter_max_ac_output_watts - slot.houseW));
      const ramped = rampedSlotExport(reachedExportW, targetExportW, slot.durationH * 60, rampWattsPerMinute);
      exportW = ramped.averageW;
      reachedExportW = ramped.endW;
    } else {
      reachedExportW = 0;
      if (buySetW === 0 && slot.pvW < slot.houseW + parasiticW + 380) {
        // Baseline "feed when no solar" that nets out the inverter's constant grid draw
        exportW = knobs.baseline_feed_watts;
      }
    }

    let netBattW: number;
    if (gridChargeW > 0) {
      netBattW = slot.pvW + gridChargeW;
    } else {
      netBattW = slot.pvW - slot.houseW - parasiticW - exportW;
    }
    const deltaWh =
      netBattW >= 0
        ? netBattW * knobs.charge_efficiency * slot.durationH
        : (netBattW / knobs.discharge_efficiency) * slot.durationH;
    socWh += deltaWh;

    if (socWh > cap) {
      // Battery full: surplus PV flows to the grid by itself (solar-mode feeding)
      const overflowInBatteryWh = socWh - cap;
      autoExportWh += overflowInBatteryWh / knobs.charge_efficiency;
      autoExportWPerSlot[i] = Math.round(overflowInBatteryWh / knobs.charge_efficiency / slot.durationH);
      revenueSek += (overflowInBatteryWh / knobs.charge_efficiency / 1000) * (spot + knobs.sell_bonus_sek_per_kwh);
      socWh = cap;
    }
    if (socWh < floorEmergencyWh) {
      // Battery can't go lower — the house pulls the deficit from the grid (unavoidable import)
      const deficitWh = floorEmergencyWh - socWh;
      const importedForHouseWh = deficitWh * knobs.discharge_efficiency;
      slotImportWh += importedForHouseWh;
      socWh = floorEmergencyWh;
    }

    const exportedWh = exportW * slot.durationH;
    sellExportWh += sellSetW > 0 ? exportedWh : 0;
    revenueSek += (exportedWh / 1000) * (spot + knobs.sell_bonus_sek_per_kwh);
    importWh += slotImportWh;
    revenueSek -= (slotImportWh / 1000) * (spot + knobs.buy_surcharges_sek_per_kwh) * knobs.vat_multiplier;

    const floorWh = slot.pvW > slot.houseW + parasiticW ? floorSunnyWh : floorPlannerWh;
    if (socWh < floorWh) violationWh += floorWh - socWh;
    if (socWh < minSocWh) {
      minSocWh = socWh;
      minSocMs = slot.endMs;
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
    autoExportWPerSlot,
  };
}

/**
 * How fast grid feed-in climbs: sell_ramp_minutes is the time from 0 to the full
 * inverter_max_ac_output_watts, so a smaller target is reached proportionally sooner. Measured at
 * ~1.4 kW/min whatever the target or starting level: 0 → 4.9 kW in ~3.5 min (2026-07-12), 0 →
 * 9.8 kW in ~7 min (2026-10-29), and mid-run 4.8 → 14.8 kW in ~7 min (2026-09-14) and 9.9 → 14.9 kW
 * in ~3.5 min (2026-09-24). Infinity when the ramp is switched off (0).
 */
export function sellRampWattsPerMinute(knobs: PlannerKnobs): number {
  return knobs.sell_ramp_minutes > 0 ? knobs.inverter_max_ac_output_watts / knobs.sell_ramp_minutes : Infinity;
}

/** Minutes the feed-in needs to climb from fromW to toW (0 when it doesn't climb) */
export function sellRampMinutesBetween(knobs: PlannerKnobs, fromW: number, toW: number): number {
  return toW > fromW ? (toW - fromW) / sellRampWattsPerMinute(knobs) : 0;
}

/**
 * One slot of feed-in that starts at startW and heads for targetW: an increase climbs linearly at
 * rampWattsPerMinute until it reaches the target (possibly not within the slot), a decrease is
 * immediate (2026-09-14's 15 → 5 kW step-down took under a minute, command latency included).
 * Returns the slot's average export and the level reached at its end, integrated exactly (the
 * curve is piecewise linear).
 */
export function rampedSlotExport(
  startW: number,
  targetW: number,
  slotMinutes: number,
  rampWattsPerMinute: number
): { averageW: number; endW: number } {
  if (targetW <= startW || slotMinutes <= 0) return { averageW: targetW, endW: targetW };
  const minutesToTarget = (targetW - startW) / rampWattsPerMinute;
  if (minutesToTarget >= slotMinutes) {
    const endW = startW + rampWattsPerMinute * slotMinutes;
    return { averageW: (startW + endW) / 2, endW };
  }
  const rampWattMinutes = ((startW + targetW) / 2) * minutesToTarget;
  const heldWattMinutes = targetW * (slotMinutes - minutesToTarget);
  return { averageW: (rampWattMinutes + heldWattMinutes) / slotMinutes, endW: targetW };
}

export function overlapsVeto(
  slot: { startMs: number; endMs: number },
  vetoes: { startMs: number; endMs: number }[]
): boolean {
  return vetoes.some(veto => veto.startMs < slot.endMs && veto.endMs > slot.startMs);
}

/**
 * Whether the planner may put NEW selling into this slot at all: priced, not claimed by a fixed
 * (user/kept) window and not vetoed. Callers layer their own extra rules on top (the greedy adds
 * the min-spot cutoff; fills/relocations add sellW/buyW-empty checks).
 */
export function slotTradableForSell(slot: Slot, sellVetoWindows: { startMs: number; endMs: number }[]): boolean {
  return (
    slot.spot !== undefined && slot.fixedSellW === 0 && slot.fixedBuyW === 0 && !overlapsVeto(slot, sellVetoWindows)
  );
}
