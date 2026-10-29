/**
 * Window packaging for generatePlan, once every allocation pass is done: merges the accepted per-slot
 * sells and buys into schedule windows (a time-contiguous chain shorter than min_window_minutes is
 * dropped, a power step starts a new window) and turns each window into the PlannedWindow the
 * auto-trader writes to the schedule — its start, expected energy, average spot and the reason text.
 */

import type { PlannedWindow, PlannerInput, SimResult, Slot } from "./planner.types.ts";

export type MergedWindow = {
  startMs: number;
  endMs: number;
  watts: number;
  kind: "sell" | "buy";
  slotIndexes: number[];
};

/** What toPlanned reads from the finished plan */
export type PackagingContext = {
  input: PlannerInput;
  slots: Slot[];
  /** The final plan's simulation: the SOC trajectory a window's reason quotes */
  finalResult: SimResult;
  /** Every priced slot's spot, ascending — what a window's P-percentile ranks against */
  spotsAll: number[];
  /** Buy slots the arbitrage pass accepted: their windows explain themselves as arbitrage */
  arbitrageBuySlots: Set<number>;
};

export function mergeAcceptedSlots(
  slots: Slot[],
  accepted: number[],
  wattsBySlot: number[],
  kind: "sell" | "buy",
  min_window_minutes: number
): {
  windows: MergedWindow[];
  droppedShort: number;
} {
  const sorted = [...accepted].sort((earlierIndex, laterIndex) => earlierIndex - laterIndex);
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

export function toPlanned(mergedWindow: MergedWindow, packaging: PackagingContext): PlannedWindow {
  const { input, slots, finalResult, spotsAll, arbitrageBuySlots } = packaging;
  const knobs = input.knobs;
  const cap = input.capacityWh;
  const spots = mergedWindow.slotIndexes.map(slotIndex => slots[slotIndex].spot!).filter(spot => spot !== undefined);
  const avgSpot = spots.reduce((sum, spot) => sum + spot, 0) / Math.max(spots.length, 1);
  // A window in the current slot starts from the input SOC, not from the SOC after its own first slot
  const firstSlotIndex = mergedWindow.slotIndexes[0];
  const socBefore =
    firstSlotIndex === 0 ? (input.socPercent / 100) * cap : finalResult.socAfterSlot[firstSlotIndex - 1];
  const socAfter = finalResult.socAfterSlot[mergedWindow.slotIndexes[mergedWindow.slotIndexes.length - 1]];
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
      ? `spot avg ${avgSpot.toFixed(2)} SEK/kWh (P${percentileOf(avgSpot, spotsAll)} of horizon), ~${expectedKwh.toFixed(0)} kWh, SOC ${Math.round((socBefore / cap) * 100)}%→${Math.round((socAfter / cap) * 100)}%`
      : isArbitrage
        ? `arbitrage: buying ~${expectedKwh.toFixed(0)} kWh at ${avgSpot.toFixed(2)} SEK/kWh (P${percentileOf(avgSpot, spotsAll)}) to re-sell at the later price peak`
        : `cheap spot avg ${avgSpot.toFixed(2)} SEK/kWh (P${percentileOf(avgSpot, spotsAll)}), pre-buying ~${expectedKwh.toFixed(0)} kWh to avoid pricier unavoidable import`;
  return {
    startMs: mergedWindow.kind === "sell" ? sellWindowStartMs(mergedWindow, slots, input.nowMs) : mergedWindow.startMs,
    endMs: mergedWindow.endMs,
    watts: mergedWindow.watts,
    kind: mergedWindow.kind,
    reason,
    expectedKwh,
    avgSpot,
  };
}

/**
 * Where a planned sell window's schedule entry starts. One that begins in the current slot only
 * starts feeding once the plan is applied. Keyed at the slot's start, every later projection (the
 * guard's check every 15 min) would seed it with ramp time it never had: ~0.9 kWh of drain for a
 * plan made 7 min into the slot, a phantom breach the guard then answered by shedding sells (PR #77
 * re-review). So it starts at the next whole minute after nowMs instead:
 *   - the runtime starts feeding at the key, so the ramp a later projection seeds from it is the one
 *     the inverter actually ran; the plan's own projection assumed a start up to a minute earlier,
 *     which errs safe (a little more drain than real)
 *   - keys stay on whole minutes: the Trading page identifies schedule rows by their start minute
 * A window that continues a feed already running at nowMs (a daily run rewriting one of our running
 * windows) keeps the slot's start: that feed never stopped.
 */
function sellWindowStartMs(window: MergedWindow, slots: Slot[], nowMs: number): number {
  if (window.slotIndexes[0] !== 0 || slots[0].feedInAtStartW > 0) return window.startMs;
  const nextWholeMinuteMs = Math.ceil(nowMs / 60_000) * 60_000;
  // In its last minute, a window keeps a minute to run instead of ending as it starts
  return Math.max(window.startMs, Math.min(nextWholeMinuteMs, window.endMs - 60_000));
}

/** Where value ranks among the horizon's spots (ascending), as a whole percentile */
function percentileOf(value: number, spotsAll: number[]): number {
  return Math.round((spotsAll.filter(spot => spot <= value).length / spotsAll.length) * 100);
}
