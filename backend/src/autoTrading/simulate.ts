/**
 * The planner's battery/revenue simulation core: replay a candidate schedule (per-slot sell/buy
 * setpoints + fixed windows) over the forecast horizon and report revenue, floor violations and
 * the SOC trajectory. Shared by the greedy allocation in planner.ts and the local search in
 * sellConsolidation.ts, which is why it lives in its own module.
 */

import type { PlannerInput, SimResult, Slot } from "./planner.types.ts";

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
  // Minutes of continuous selling so far — the inverter ramps grid feed-in slowly (grid safety),
  // so the first sell_ramp_minutes of every (re)start deliver reduced power.
  let sellRunMinutes = 0;

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
      exportW = Math.min(sellSetW, knobs.inverter_max_ac_output_watts - slot.houseW);
      exportW = Math.max(exportW, 0);
      // Average ramp factor over this slot: linear 0→100% across the first sell_ramp_minutes of the run
      const rampMin = knobs.sell_ramp_minutes;
      if (rampMin > 0 && sellRunMinutes < rampMin) {
        const slotMin = slot.durationH * 60;
        const rampedFrom = sellRunMinutes;
        const rampedTo = rampedFrom + slotMin;
        const rampedUntil = Math.min(rampedTo, rampMin);
        const avgFactor =
          ((rampedUntil * rampedUntil - rampedFrom * rampedFrom) / (2 * rampMin) +
            Math.max(0, rampedTo - rampedUntil)) /
          slotMin;
        exportW *= avgFactor;
      }
      sellRunMinutes += slot.durationH * 60;
    } else {
      sellRunMinutes = 0;
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
  };
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
