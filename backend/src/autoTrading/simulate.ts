/**
 * The planner's battery/revenue simulation core: replay a candidate schedule (per-slot sell/buy
 * setpoints, holds + fixed windows) over the forecast horizon and report revenue (with the terminal value
 * of the energy left at the end, when the plan has one), floor violations and the SOC trajectory. Shared by the allocation passes (sellAllocation.ts, buyAllocation.ts, holdAllocation.ts) and the
 * local search in sellConsolidation.ts, which is why it lives in its own module. The revenue is what the utility
 * meter will count (knobs.meter_calibration, simulatedMeterCredit.ts); the energies and the SOC stay as the
 * inverter sees them.
 */

import { rampedSlotExport, sellRampWattsPerMinute } from "./feedInRamp.ts";
import { HOLD_CLASS_MAX_WATTS } from "./plannerKnobBounds.ts";
import {
  extraImportWatts,
  feedReadingShortfallWatts,
  passThroughExtraImportWatts,
  uncountedExportWatts,
} from "./simulatedMeterCredit.ts";
import type { HorizonValuation, PlannerInput, PlannerKnobs, SimResult, Slot } from "./planner.types.ts";

/** A buy slot grid-charges only while the battery starts it below this share of its capacity */
export const GRID_CHARGE_UP_TO_SOC_FRACTION = 0.98;

export function simulate(
  input: PlannerInput,
  slots: Slot[],
  sellW: number[],
  buyW: number[],
  valuation: HorizonValuation
): SimResult {
  const knobs = input.knobs;
  const calibration = knobs.meter_calibration;
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
  let shortfallImportWh = 0;
  let boughtWh = 0;
  const socAfterSlot: number[] = new Array(slots.length);
  const autoExportWPerSlot: number[] = new Array(slots.length).fill(0);
  const sellExportWhPerSlot: number[] = new Array(slots.length).fill(0);
  // The export level the feed-in had reached when the previous slot ended (feedInRamp.ts: it climbs
  // at a fixed rate on a start and on a mid-run step-up alike, and drops at once). Slot 0 starts
  // where a window that is already running has got to (buildSlots works that out once).
  const rampWattsPerMinute = sellRampWattsPerMinute(knobs);
  let reachedExportW = slots[0]?.feedInAtStartW ?? 0;
  const modelHolds = holdsModelled(knobs, valuation);

  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    const spot = slot.spot ?? valuation.tailSpot;
    const parasiticW = input.parasiticWatts;
    const sellSetW = Math.max(sellW[i], slot.fixedSellW);
    const requestedBuyW = Math.max(buyW[i], slot.fixedBuyW);
    // Runtime never does both at once (feedWhenNoSolar errors out) — selling wins in our model
    const buySetW = sellSetW > 0 ? 0 : requestedBuyW;

    const holdPowerW = modelHolds && sellSetW === 0 ? holdPowerInSlot(slot, buyW[i]) : 0;
    if (holdPowerW > 0) {
      // A hold (a buy window at a trickle): the house, the inverter's idle draw and its extra draw in charge
      // mode come from the grid; PV and the trickle go into the battery, the trickle only as far as the
      // battery has room; no baseline feed. The buy branch below credits PV to the house and the battery
      // both and stops a window at 98 %; a hold runs the house from the grid at any SOC.
      const headroomAcW = Math.max(0, (cap - socWh) / knobs.charge_efficiency / slot.durationH);
      const trickleW = Math.max(0, Math.min(holdPowerW, headroomAcW - slot.pvW));
      const holdImportWh = (slot.houseW + parasiticW + trickleW + knobs.hold_overhead_watts) * slot.durationH;
      socWh += (slot.pvW + trickleW) * knobs.charge_efficiency * slot.durationH;
      if (socWh > cap) {
        // PV beyond the battery's room flows to the grid by itself, as in a full battery's idle slot
        const overflowInBatteryWh = socWh - cap;
        autoExportWh += overflowInBatteryWh / knobs.charge_efficiency;
        autoExportWPerSlot[i] = Math.round(overflowInBatteryWh / knobs.charge_efficiency / slot.durationH);
        revenueSek += (overflowInBatteryWh / knobs.charge_efficiency / 1000) * (spot + knobs.sell_bonus_sek_per_kwh);
        socWh = cap;
      }
      // A hold gets no meter correction: hold_overhead_watts is the meter-level draw (~170 W measured on
      // 2025-26 holds), and the inverter's draw is already in it, so neither the import nor a PV overflow
      // (which nets against that import at the meter) pays it again
      importWh += holdImportWh;
      revenueSek -= (holdImportWh / 1000) * (spot + knobs.buy_surcharges_sek_per_kwh) * knobs.vat_multiplier;
      // A sell right after a hold ramps from nothing: the baseline feed is off during buy windows
      reachedExportW = 0;
      const holdFloorWh = slot.pvW > slot.houseW + parasiticW ? floorSunnyWh : floorPlannerWh;
      if (socWh < holdFloorWh) violationWh += holdFloorWh - socWh;
      if (socWh < minSocWh) {
        minSocWh = socWh;
        minSocMs = slot.endMs;
      }
      socAfterSlot[i] = socWh;
      continue;
    }

    let exportW = 0;
    let gridChargeW = 0;
    let slotImportWh = 0;
    // The meter's view of the slot (simulatedMeterCredit.ts): how far the feed's reading sits below exportW,
    // and what the meter counts on top of the slot's imports
    let feedReadingShortfallW = 0;
    let overflowW = 0;
    let meterExtraImportW = 0;
    const ratingHeadroomW = knobs.inverter_max_ac_output_watts - slot.houseW;

    if (buySetW > 0 && socWh < cap * GRID_CHARGE_UP_TO_SOC_FRACTION) {
      // AC charging: battery charges from grid, house is fed from grid too
      gridChargeW = buySetW;
      const chargeImportW = buySetW + slot.houseW + parasiticW - Math.min(slot.pvW, buySetW + slot.houseW + parasiticW);
      slotImportWh += chargeImportW * slot.durationH;
      boughtWh += buySetW * slot.durationH;
      meterExtraImportW += extraImportWatts(chargeImportW, 1, "AC to DC", calibration);
    }

    const sellingThisSlot = sellSetW > 0 && socWh > floorRuntimeWh;
    if (sellingThisSlot) {
      // Export is limited by what battery + PV can physically supply beyond the house
      // House has first dibs on the inverter's AC output; export gets the rest of the 15 kW rating
      const targetExportW = Math.max(0, Math.min(sellSetW, ratingHeadroomW));
      const ramped = rampedSlotExport(reachedExportW, targetExportW, slot.durationH * 60, rampWattsPerMinute);
      exportW = ramped.averageW;
      reachedExportW = ramped.endW;
      feedReadingShortfallW = feedReadingShortfallWatts(sellSetW, ratingHeadroomW, calibration);
    } else {
      if (buySetW === 0 && slot.pvW < slot.houseW + parasiticW + 380) {
        // Baseline "feed when no solar" that nets out the inverter's constant grid draw. It drains the battery by
        // the whole setpoint, but the meter counts little of it: at 300 W about nothing (simulatedMeterCredit.ts)
        exportW = knobs.baseline_feed_watts;
        feedReadingShortfallW = feedReadingShortfallWatts(exportW, ratingHeadroomW, calibration);
      }
      // A sell that follows climbs from whatever is being fed now (the baseline feed, or nothing)
      reachedExportW = exportW;
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
      overflowW = overflowInBatteryWh / knobs.charge_efficiency / slot.durationH;
      socWh = cap;
    }
    if (socWh < floorEmergencyWh) {
      // Battery can't go lower — the house pulls the deficit from the grid (unavoidable import)
      const deficitWh = floorEmergencyWh - socWh;
      const importedForHouseWh = deficitWh * knobs.discharge_efficiency;
      slotImportWh += importedForHouseWh;
      shortfallImportWh += importedForHouseWh;
      socWh = floorEmergencyWh;
      meterExtraImportW += passThroughExtraImportWatts(importedForHouseWh / slot.durationH, -netBattW, calibration);
    }

    const exportedWh = exportW * slot.durationH;
    if (sellSetW > 0) {
      sellExportWh += exportedWh;
      sellExportWhPerSlot[i] = exportedWh;
    }
    revenueSek += (exportedWh / 1000) * (spot + knobs.sell_bonus_sek_per_kwh);
    importWh += slotImportWh;
    revenueSek -= (slotImportWh / 1000) * (spot + knobs.buy_surcharges_sek_per_kwh) * knobs.vat_multiplier;
    // Credited at what the meter counts: less of the feed and the PV let through, more on top of the imports
    // (0 at the identity calibration). The energies above stay as the inverter sees them.
    const uncountedExportWh =
      uncountedExportWatts(exportW + overflowW, feedReadingShortfallW, calibration) * slot.durationH;
    revenueSek -= (uncountedExportWh / 1000) * (spot + knobs.sell_bonus_sek_per_kwh);
    revenueSek -=
      ((meterExtraImportW * slot.durationH) / 1000) * (spot + knobs.buy_surcharges_sek_per_kwh) * knobs.vat_multiplier;

    const floorWh = slot.pvW > slot.houseW + parasiticW ? floorSunnyWh : floorPlannerWh;
    if (socWh < floorWh) violationWh += floorWh - socWh;
    if (socWh < minSocWh) {
      minSocWh = socWh;
      minSocMs = slot.endMs;
    }
    socAfterSlot[i] = socWh;
  }

  // The energy left at the end saves a later import (terminalValue.ts). Credited inside revenueSek, the
  // number every allocation pass compares, so keeping a kWh competes with selling it on equal terms. A
  // forecast gap can leave socWh NaN; the revenue must stay a number then, as it does without the credit
  const endEnergyValueSek =
    valuation.endEnergySekPerKwh > 0 && Number.isFinite(socWh)
      ? (Math.max(0, socWh - floorEmergencyWh) / 1000) * valuation.endEnergySekPerKwh
      : 0;
  if (endEnergyValueSek) revenueSek += endEnergyValueSek;

  return {
    revenueSek,
    violationWh,
    minSocWh,
    minSocMs,
    endSocWh: socWh,
    sellExportWh,
    sellExportWhPerSlot,
    autoExportWh,
    importWh,
    shortfallImportWh,
    boughtWh,
    socAfterSlot,
    autoExportWPerSlot,
    endEnergyValueSek,
  };
}

/**
 * Whether this plan models holds: hold_enabled, and only together with an active terminal value (without
 * one, energy kept past the horizon is worth nothing, so a hold never pays). Off, simulate is exactly the
 * one without holds, fixed low-power buy windows included: they stay buys.
 * Not with buy windows inside the hold class either (holdsUnplannableReason): the plan would simulate its own
 * buys as charges and every replay of them (a kept window, the gain gate, the reserve guard) as holds.
 */
export function holdsModelled(
  knobs: Pick<PlannerKnobs, "hold_enabled" | "max_buy_power_watts">,
  valuation: Pick<HorizonValuation, "endEnergySekPerKwh">
): boolean {
  return knobs.hold_enabled === true && valuation.endEnergySekPerKwh > 0 && holdsUnplannableReason(knobs) === undefined;
}

/** Why holds can't be planned with these knobs although hold_enabled is on, or undefined when they can */
export function holdsUnplannableReason(knobs: Pick<PlannerKnobs, "max_buy_power_watts">): string | undefined {
  if (knobs.max_buy_power_watts > HOLD_CLASS_MAX_WATTS) return undefined;
  return `the buy charging power (${knobs.max_buy_power_watts} W) is within the ${HOLD_CLASS_MAX_WATTS} W hold class, so every buy window would run as a hold`;
}

/**
 * The hold power in a slot that doesn't sell, in a plan that models holds: the hold pass's (slot.holdW), or
 * a fixed buy window in the hold class (HOLD_CLASS_MAX_WATTS: a written hold the plan keeps, or the user's,
 * which the runtime runs as a hold too while hold_enabled is on).
 * A planned buy is a buy, and a fixed buy above hold power one too, even over a planned hold.
 */
function holdPowerInSlot(slot: Slot, plannedBuyW: number): number {
  if (plannedBuyW > 0) return 0;
  if (slot.fixedBuyW > 0) return slot.fixedBuyW <= HOLD_CLASS_MAX_WATTS ? slot.fixedBuyW : 0;
  return slot.holdW;
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
