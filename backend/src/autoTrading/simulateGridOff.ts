/**
 * The planner's model of automatic grid-off (gridOff/autoGridOffDecisions.ts): a cheap stand-in for the
 * runtime's rules, judged on the candidate schedule a simulation runs (simulate.ts). With grid_off.auto_enabled a
 * quarter is modelled off the grid (Off-Grid III, the grid relay open) when
 * - no window is in it: a sell, a buy or a hold, planned or fixed, as simulate's setpoints have it;
 * - the next window's reconnect (its start less reconnect_before_window_minutes) comes no earlier than its end;
 * - the stretch off the grid that leaves, from the end of the window before it (or the plan's start) to that
 *   reconnect, is at least auto_min_off_minutes: a shorter one the runtime never starts;
 * - and the battery starts it inside offGridSocBand.
 * There the inverter feeds nothing (no baseline night feed: neither its credit nor its drain) and draws
 * grid_off_saving_watts less of its own. Off, none of this runs and simulate is exactly the one without it.
 *
 * Left out: the hysteresis on either side of the band (offGridSocBand), a stretch entered mid-gap because the SOC
 * only reaches the band later (the runtime then needs auto_min_off_minutes from there), a 0 W fixed window (a slot
 * carries no flag for one), and what only the live switch knows (stale readings, the energy-settings restore,
 * the rate limit, a failed switch).
 */
import type { GridOffConfig } from "../config/config.types.ts";
import type { PlannerInput, PlannerKnobs, SimResult, Slot } from "./planner.types.ts";

/**
 * Main: per slot, whether the candidate schedule's windows leave it off the grid (the SOC band aside). Two
 * passes over the slots: the next window's start backwards, then the stretch from the last window's end forwards.
 */
export function offGridWindowGaps(
  input: Pick<PlannerInput, "nowMs" | "knobs">,
  slots: readonly Slot[],
  sellW: readonly number[],
  buyW: readonly number[],
  modelHolds: boolean
): boolean[] {
  const settings = input.knobs.grid_off;
  const leadMs = settings.reconnect_before_window_minutes * 60_000;
  const minOffMs = settings.auto_min_off_minutes * 60_000;
  const windowInSlot = slots.map((slot, slotIndex) =>
    slotHasWindow(slot, sellW[slotIndex] ?? 0, buyW[slotIndex] ?? 0, modelHolds)
  );
  const nextWindowStartMs: number[] = new Array(slots.length);
  let upcomingWindowStartMs = Infinity;
  for (let slotIndex = slots.length - 1; slotIndex >= 0; slotIndex--) {
    if (windowInSlot[slotIndex]) upcomingWindowStartMs = slots[slotIndex]!.startMs;
    nextWindowStartMs[slotIndex] = upcomingWindowStartMs;
  }
  const offGrid: boolean[] = new Array(slots.length);
  let stretchStartMs = input.nowMs;
  for (let slotIndex = 0; slotIndex < slots.length; slotIndex++) {
    const slot = slots[slotIndex]!;
    if (windowInSlot[slotIndex]) {
      offGrid[slotIndex] = false;
      stretchStartMs = slot.endMs;
      continue;
    }
    const reconnectAtMs = nextWindowStartMs[slotIndex]! - leadMs;
    offGrid[slotIndex] = slot.endMs <= reconnectAtMs && reconnectAtMs - stretchStartMs >= minOffMs;
  }
  return offGrid;
}

/** Whether the plan models automatic grid-off: grid_off.auto_enabled (corrected) */
export function autoGridOffModelled(knobs: Pick<PlannerKnobs, "grid_off">): boolean {
  return knobs.grid_off.auto_enabled === true;
}

/**
 * The battery energy (Wh) a quarter must start at to be modelled off the grid: from min_soc_percent up to below
 * auto_resume_soc_percent. That is the band the runtime is off the grid in as the battery falls through it at
 * night, which is where the night feed is at stake: falling from full it stays on the grid down to
 * auto_resume_soc_percent, and off it down to min_soc_percent. Rising (PV) it would stay off up to
 * auto_full_soc_percent and only come back from min + switch_on_soc_margin_percent; the model carries no such state.
 */
export type OffGridSocBand = { fromWh: number; belowWh: number };

export function offGridSocBand(
  settings: Pick<GridOffConfig, "min_soc_percent" | "auto_resume_soc_percent">,
  capacityWh: number
): OffGridSocBand {
  return {
    fromWh: (settings.min_soc_percent / 100) * capacityWh,
    belowWh: (settings.auto_resume_soc_percent / 100) * capacityWh,
  };
}

/** The plan note on the quarters modelled off the grid, while automatic grid-off is modelled */
export function autoGridOffNote(
  knobs: Pick<PlannerKnobs, "grid_off" | "grid_off_saving_watts">,
  result: Pick<SimResult, "offGridHours">
): string | undefined {
  if (!autoGridOffModelled(knobs)) return undefined;
  const settings = knobs.grid_off;
  return `Automatic grid-off: ${result.offGridHours.toFixed(1)} h modelled off the grid (no night feed there, the inverter's own draw ${knobs.grid_off_saving_watts} W lower): idle quarters ${settings.reconnect_before_window_minutes} min clear of any window, in stretches of at least ${settings.auto_min_off_minutes} min, starting between ${settings.min_soc_percent} % and ${settings.auto_resume_soc_percent} % SOC`;
}

/**
 * Whether the slot has a window in simulate's terms: a sell or buy setpoint (planned or fixed), or a hold the
 * plan models. Any power counts, as at runtime: a sell the SOC cutoff stops is still a window on the grid.
 */
function slotHasWindow(slot: Slot, plannedSellW: number, plannedBuyW: number, modelHolds: boolean): boolean {
  return (
    plannedSellW > 0 || slot.fixedSellW > 0 || plannedBuyW > 0 || slot.fixedBuyW > 0 || (modelHolds && slot.holdW > 0)
  );
}
