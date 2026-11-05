/**
 * The planner's model of automatic grid-off (gridOff/autoGridOffDecisions.ts), judged on the candidate schedule a
 * simulation runs (simulate.ts), slot by slot with one boolean carried through its loop, as the runtime carries
 * the switch's request. With grid_off.auto_enabled a quarter is off the grid (Off-Grid III, the grid relay open)
 * when no window is in it (a sell, a buy or a hold, planned or fixed: what simulate's setpoints say) and the next
 * window's reconnect (its start less reconnect_before_window_minutes) comes no earlier than its end, and
 * - on the grid before it, the battery starts it from min_soc_percent + switch_on_soc_margin_percent up to below
 *   auto_resume_soc_percent, with at least auto_min_off_minutes from its start to that reconnect;
 * - off the grid before it, the battery starts it from min_soc_percent up to below auto_full_soc_percent.
 * There the inverter feeds nothing to the grid and draws grid_off_saving_watts less from the battery: the night
 * feed's battery drain stays, since the inverter burns most of what the feed covered itself (the meter counts
 * ~nothing of the feed, simulatedMeterCredit.ts), and the saving is the whole battery-side difference. Off, none
 * of this runs and simulate is exactly the one without it.
 *
 * Left out: the live switch's own conditions (stale readings, the energy-settings restore, the rate limit, a failed
 * switch), a 0 W fixed window (a slot carries no flag for one), and the switch's state when the plan starts: the
 * plan starts on the grid, so a stretch the runtime is in already is entered at the first quarter the entry band
 * allows (counting less saving, never more).
 */
import type { GridOffConfig } from "../config/config.types.ts";
import type { PlannerInput, PlannerKnobs, SimResult, Slot } from "./planner.types.ts";

/** Per slot, what the candidate schedule's windows allow (the SOC aside) */
export type OffGridWindowGaps = {
  /** No window in the slot, and the next one's reconnect no earlier than its end: off the grid may continue */
  windowFree: boolean[];
  /** …and from its start to that reconnect is at least auto_min_off_minutes: off the grid may start here */
  entryAllowed: boolean[];
};

/** Main: per slot, the windows' part of the rules. Two passes: the next window's start backwards, then the slots. */
export function offGridWindowGaps(
  input: Pick<PlannerInput, "nowMs" | "knobs">,
  slots: readonly Slot[],
  sellW: readonly number[],
  buyW: readonly number[],
  modelHolds: boolean
): OffGridWindowGaps {
  const settings = input.knobs.grid_off;
  const leadMs = settings.reconnect_before_window_minutes * 60_000;
  const minOffMs = settings.auto_min_off_minutes * 60_000;
  const nextWindowStartMs: number[] = new Array(slots.length);
  const windowInSlot: boolean[] = new Array(slots.length);
  let upcomingWindowStartMs = Infinity;
  for (let slotIndex = slots.length - 1; slotIndex >= 0; slotIndex--) {
    const slot = slots[slotIndex]!;
    windowInSlot[slotIndex] = slotHasWindow(slot, sellW[slotIndex] ?? 0, buyW[slotIndex] ?? 0, modelHolds);
    if (windowInSlot[slotIndex]) upcomingWindowStartMs = slot.startMs;
    nextWindowStartMs[slotIndex] = upcomingWindowStartMs;
  }
  const windowFree: boolean[] = new Array(slots.length);
  const entryAllowed: boolean[] = new Array(slots.length);
  for (let slotIndex = 0; slotIndex < slots.length; slotIndex++) {
    const slot = slots[slotIndex]!;
    const reconnectAtMs = nextWindowStartMs[slotIndex]! - leadMs;
    windowFree[slotIndex] = !windowInSlot[slotIndex] && slot.endMs <= reconnectAtMs;
    // Slot 0 starts at nowMs (buildSlots' partial slot): the runtime would judge the stretch from now
    const startsAtMs = Math.max(slot.startMs, input.nowMs);
    entryAllowed[slotIndex] = windowFree[slotIndex] && reconnectAtMs - startsAtMs >= minOffMs;
  }
  return { windowFree, entryAllowed };
}

/**
 * The battery energies (Wh) the runtime's SOC rules switch at: off the grid from enterFromWh up to below
 * enterBelowWh (min + switch_on_soc_margin_percent, auto_resume_soc_percent), on it again below stayFromWh or from
 * stayBelowWh (min_soc_percent, auto_full_soc_percent)
 */
export type OffGridSocBands = { enterFromWh: number; enterBelowWh: number; stayFromWh: number; stayBelowWh: number };

export function offGridSocBands(settings: GridOffConfig, capacityWh: number): OffGridSocBands {
  const whAt = (percent: number) => (percent / 100) * capacityWh;
  return {
    enterFromWh: whAt(settings.min_soc_percent + settings.switch_on_soc_margin_percent),
    enterBelowWh: whAt(settings.auto_resume_soc_percent),
    stayFromWh: whAt(settings.min_soc_percent),
    stayBelowWh: whAt(settings.auto_full_soc_percent),
  };
}

/** Whether slot slotIndex, which the battery starts at socWh, is off the grid, given whether the one before was */
export function offGridInSlot(
  offGridBefore: boolean,
  gaps: OffGridWindowGaps,
  slotIndex: number,
  socWh: number,
  bands: OffGridSocBands
): boolean {
  if (!gaps.windowFree[slotIndex]) return false;
  if (offGridBefore) return socWh >= bands.stayFromWh && socWh < bands.stayBelowWh;
  return gaps.entryAllowed[slotIndex] === true && socWh >= bands.enterFromWh && socWh < bands.enterBelowWh;
}

/**
 * What the battery feeds the inverter's own draw in a quarter off the grid (W): the idle draw and the night feed's
 * drain (feedDrainW, what the feed would set there on the grid) less grid_off_saving_watts, never below 0
 */
export function offGridOwnDrawWatts(parasiticW: number, feedDrainW: number, savingW: number): number {
  return Math.max(0, parasiticW + feedDrainW - savingW);
}

/** Whether the plan models automatic grid-off: grid_off.auto_enabled (corrected) */
export function autoGridOffModelled(knobs: Pick<PlannerKnobs, "grid_off">): boolean {
  return knobs.grid_off.auto_enabled === true;
}

/** The plan note on the quarters modelled off the grid, while automatic grid-off is modelled */
export function autoGridOffNote(
  knobs: Pick<PlannerKnobs, "grid_off" | "grid_off_saving_watts">,
  result: Pick<SimResult, "offGridHours">
): string | undefined {
  if (!autoGridOffModelled(knobs)) return undefined;
  const settings = knobs.grid_off;
  return `Automatic grid-off: ${result.offGridHours.toFixed(1)} h modelled off the grid (no night-feed credit there, the battery drains ${knobs.grid_off_saving_watts} W less): idle quarters ${settings.reconnect_before_window_minutes} min clear of any window, switching off from ${settings.min_soc_percent + settings.switch_on_soc_margin_percent} % to below ${settings.auto_resume_soc_percent} % SOC with ${settings.auto_min_off_minutes} min ahead, back on below ${settings.min_soc_percent} % or at ${settings.auto_full_soc_percent} %`;
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
