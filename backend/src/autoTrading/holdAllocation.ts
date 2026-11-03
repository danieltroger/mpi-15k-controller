/**
 * The planner's hold pass (called by generatePlan last, after the sell and buy passes). A hold quarter runs
 * the house from the grid through a buy window at hold_power_watts: while AC charging is on the inverter
 * feeds the house from the grid and only trickles into the battery, so the battery keeps its energy for
 * pricier hours without the round trip a buy-and-use costs. That only pays when the kept energy is worth
 * something past the horizon, so the pass runs only while the terminal value applies (simulate.ts's
 * holdsModelled).
 *
 * Last, not before the pre-buy: there the greedy, judged against a plan with no buys yet, kept holds at dear
 * quarters because they averted a projected shortfall, which left the pre-buy (and its cheaper energy)
 * nothing to avert. In the 2022-11 → 2026-11 backtest on top of the terminal value at its defaults that lost
 * money against the terminal value alone, ~100–230 SEK per winter behind holding last.
 */

import { holdsModelled, holdsUnplannableReason, overlapsVeto, simulate } from "./simulate.ts";
import { isRunningHoldSlot } from "./runningHold.ts";
import { SLOT_MS } from "./slotDuration.ts";
import type { AllocationContext, SimResult } from "./planner.types.ts";

/**
 * Simulations the hold pass may spend, as a block search its 400 (blockBuying.ts): a guard, not a tunable.
 * The pass tries each dark priced quarter once (≤ ~140 over a 35 h horizon) plus a bridge per gap, so the
 * budget only binds on an unusually long horizon; the pi Zero 2 W plans on the event loop the inverter
 * comms share. A cut-short pass says so in the plan notes.
 */
const HOLD_PASS_TRIALS = 400;

export type HoldPassResult = {
  result: SimResult;
  /** The budget ran out before every candidate quarter was tried */
  budgetCut: boolean;
};

/**
 * Main: holds the free dark quarters where that pays, cheapest first, keeping a hold when the plan gains at
 * least hold_margin_sek_per_kwh per kWh the house (with the inverter's idle draw) imports in that quarter.
 * The gain is what simulate counts: the import now against the battery energy kept (its end-of-plan value,
 * a later shortfall import averted), the lost baseline feed, the trickle and hold_overhead_watts. Then gaps of
 * up to hold_bridge_minutes between holds are held through when that costs at most
 * fragmentation_tolerance_sek_per_window, and runs shorter than hold_min_window_minutes are dropped. Leaves
 * each hold's power in slot.holdW; a no-op unless the plan models holds. A running hold the plan re-plans
 * (runningHold.ts) holds the current quarter as a fixed window: a gap after it is bridged like one after any
 * hold, and the run that continues it is never dropped as short (it has started already).
 */
export function allocateHolds(context: AllocationContext, resultSoFar: SimResult): HoldPassResult {
  const { input, valuation } = context;
  if (!holdsModelled(input.knobs, valuation) || input.knobs.hold_power_watts <= 0) {
    return { result: resultSoFar, budgetCut: false };
  }
  const pass: HoldPass = { context, current: resultSoFar, trialsLeft: HOLD_PASS_TRIALS, budgetCut: false };
  acceptCheapestHolds(pass);
  bridgeHoldGaps(pass);
  return { result: dropShortHoldRuns(context, pass.current), budgetCut: pass.budgetCut };
}

/**
 * The slots a hold is written for: held, with no sell or buy in the slot (one would win over the hold), and
 * the current quarter of a running hold the plan re-plans, as written whatever else the slot got
 */
export function plannedHoldSlots(context: Pick<AllocationContext, "input" | "slots" | "sellW" | "buyW">): number[] {
  const { input, slots, sellW, buyW } = context;
  const holdSlots: number[] = [];
  for (let slotIndex = 0; slotIndex < slots.length; slotIndex++) {
    const plannedHold = slots[slotIndex].holdW > 0 && sellW[slotIndex] === 0 && buyW[slotIndex] === 0;
    if (plannedHold || isRunningHoldSlot(input, slotIndex)) holdSlots.push(slotIndex);
  }
  return holdSlots;
}

/** The power each slot's hold is written at: the hold pass's, and a running hold's own in its current quarter */
export function holdWattsBySlot(context: Pick<AllocationContext, "input" | "slots">): number[] {
  const { input, slots } = context;
  return slots.map((slot, slotIndex) =>
    input.runningHold && isRunningHoldSlot(input, slotIndex) ? input.runningHold.watts : slot.holdW
  );
}

/**
 * The plan note on the holds it writes, or on why it can't plan any although hold_enabled is on with a
 * terminal value; undefined otherwise
 */
export function holdNote(
  context: Pick<AllocationContext, "input" | "slots" | "valuation">,
  holdSlots: number[],
  windowCount: number,
  budgetCut: boolean
): string | undefined {
  const { input, slots, valuation } = context;
  const unplannable = holdsUnplannableReason(input.knobs);
  if (input.knobs.hold_enabled === true && valuation.endEnergySekPerKwh > 0 && unplannable) {
    return `No holds planned: ${unplannable}`;
  }
  const budgetNote = budgetCut ? " (the hold pass ran out of simulations before trying every quarter)" : "";
  if (!holdSlots.length) return budgetCut ? `No holds${budgetNote}` : undefined;
  const knobs = input.knobs;
  const hours = holdSlots.reduce((sum, slotIndex) => sum + slots[slotIndex].durationH, 0);
  const houseKwh = holdHouseKwh(context, holdSlots);
  return `Holding in ${windowCount} window(s), ${hours.toFixed(1)} h: the house runs on the grid at cheap hours (~${houseKwh.toFixed(1)} kWh) and the battery keeps its energy — ${knobs.hold_power_watts} W trickle, ${knobs.hold_overhead_watts} W assumed extra grid draw, ${knobs.hold_margin_sek_per_kwh} SEK/kWh margin${budgetNote}`;
}

/** What the house and the inverter's idle draw import over these hold slots (kWh) */
export function holdHouseKwh(context: Pick<AllocationContext, "input" | "slots">, holdSlots: number[]): number {
  const { input, slots } = context;
  return (
    holdSlots.reduce(
      (sum, slotIndex) => sum + (slots[slotIndex].houseW + input.parasiticWatts) * slots[slotIndex].durationH,
      0
    ) / 1000
  );
}

/** One hold pass: the candidate schedule, the plan with the holds kept so far, and its simulation budget */
type HoldPass = { context: AllocationContext; current: SimResult; trialsLeft: number; budgetCut: boolean };

/** The greedy: every holdable quarter once, cheapest first (the earlier one on a tie) */
function acceptCheapestHolds(pass: HoldPass) {
  const { input, slots, sellW, buyW, valuation, feasibleVsBase } = pass.context;
  const knobs = input.knobs;
  const candidates = slots
    .map((slot, slotIndex) => ({ slot, slotIndex }))
    .filter(({ slotIndex }) => slotHoldable(pass.context, slotIndex))
    .sort((cheaper, pricier) => cheaper.slot.spot! - pricier.slot.spot!);
  for (const { slot } of candidates) {
    if (pass.trialsLeft <= 0) {
      pass.budgetCut = true;
      return;
    }
    slot.holdW = knobs.hold_power_watts;
    pass.trialsLeft--;
    const trial = simulate(input, slots, sellW, buyW, valuation);
    const gainSek = trial.revenueSek - pass.current.revenueSek;
    const houseImportKwh = ((slot.houseW + input.parasiticWatts) * slot.durationH) / 1000;
    if (feasibleVsBase(trial) && gainSek > 0 && gainSek >= knobs.hold_margin_sek_per_kwh * houseImportKwh) {
      pass.current = trial;
    } else {
      slot.holdW = 0;
    }
  }
}

/**
 * Holds through gaps of up to hold_bridge_minutes between two holds, when every quarter in the gap could
 * hold and doing so costs at most fragmentation_tolerance_sek_per_window: the runtime then sees one window
 * instead of two (an EDB0/EDB1 pair fewer).
 */
function bridgeHoldGaps(pass: HoldPass) {
  const { input, slots, sellW, buyW, valuation, feasibleVsBase } = pass.context;
  const knobs = input.knobs;
  const bridgeSlots = Math.floor((knobs.hold_bridge_minutes * 60_000) / SLOT_MS);
  if (bridgeSlots <= 0) return;
  for (let gapStart = 1; gapStart < slots.length; gapStart++) {
    if (!slotHeld(pass.context, gapStart - 1) || slots[gapStart].holdW > 0) continue;
    let gapEnd = gapStart;
    while (gapEnd < slots.length && !(slots[gapEnd].holdW > 0) && gapEnd - gapStart < bridgeSlots) gapEnd++;
    if (gapEnd >= slots.length || !(slots[gapEnd].holdW > 0)) continue;
    const gap = Array.from({ length: gapEnd - gapStart }, (_, offset) => gapStart + offset);
    if (!gap.every(slotIndex => slotHoldable(pass.context, slotIndex))) continue;
    if (!contiguousInTime(pass.context, gapStart - 1, gapEnd)) continue;
    if (pass.trialsLeft <= 0) {
      pass.budgetCut = true;
      return;
    }
    for (const slotIndex of gap) slots[slotIndex].holdW = knobs.hold_power_watts;
    pass.trialsLeft--;
    const trial = simulate(input, slots, sellW, buyW, valuation);
    if (
      feasibleVsBase(trial) &&
      trial.revenueSek - pass.current.revenueSek >= -knobs.fragmentation_tolerance_sek_per_window
    ) {
      pass.current = trial;
    } else {
      for (const slotIndex of gap) slots[slotIndex].holdW = 0;
    }
    gapStart = gapEnd;
  }
}

/**
 * Drops hold runs shorter than hold_min_window_minutes, a run being time-contiguous holds, and re-simulates
 * when it dropped any. Not the run continuing a running hold: that window has started already, so ending it
 * sooner saves no EDB1/EDB0 pair.
 */
function dropShortHoldRuns(context: AllocationContext, resultSoFar: SimResult): SimResult {
  const { input, slots, sellW, buyW, valuation } = context;
  let dropped = false;
  for (const run of holdRuns(context)) {
    if (isRunningHoldSlot(input, run[0])) continue;
    const runMinutes = (slots[run[run.length - 1]].endMs - slots[run[0]].startMs) / 60_000;
    if (runMinutes >= input.knobs.hold_min_window_minutes) continue;
    for (const slotIndex of run) slots[slotIndex].holdW = 0;
    dropped = true;
  }
  return dropped ? simulate(input, slots, sellW, buyW, valuation) : resultSoFar;
}

/**
 * A quarter a hold may go into: priced, dark (forecast PV below the house and the inverter's idle draw: in
 * sun a hold would only import what PV covers), free of planned sells and buys, of the user's windows and
 * of buy vetoes (a hold is a buy window), and not held yet
 */
function slotHoldable(context: AllocationContext, slotIndex: number): boolean {
  const { input, slots, sellW, buyW } = context;
  const slot = slots[slotIndex];
  return (
    slot.spot !== undefined &&
    slot.holdW === 0 &&
    sellW[slotIndex] === 0 &&
    buyW[slotIndex] === 0 &&
    slot.fixedSellW === 0 &&
    slot.fixedBuyW === 0 &&
    slot.pvW < slot.houseW + input.parasiticWatts &&
    !overlapsVeto(slot, input.buyVetoWindows)
  );
}

/** Whether the slot holds: the hold pass's hold, or the current quarter of a running hold the plan re-plans */
function slotHeld(context: AllocationContext, slotIndex: number): boolean {
  return context.slots[slotIndex].holdW > 0 || isRunningHoldSlot(context.input, slotIndex);
}

/** Time-contiguous runs of the slots a hold is written for (plannedHoldSlots) */
function holdRuns(context: AllocationContext): number[][] {
  const runs: number[][] = [];
  for (const slotIndex of plannedHoldSlots(context)) {
    const lastRun = runs[runs.length - 1];
    const previous = lastRun?.[lastRun.length - 1];
    if (previous === slotIndex - 1 && contiguousInTime(context, previous, slotIndex)) lastRun.push(slotIndex);
    else runs.push([slotIndex]);
  }
  return runs;
}

/** Whether slots fromIndex…toIndex follow each other without a gap in the price feed */
function contiguousInTime(context: AllocationContext, fromIndex: number, toIndex: number): boolean {
  const { slots } = context;
  for (let slotIndex = fromIndex + 1; slotIndex <= toIndex; slotIndex++) {
    if (slots[slotIndex].startMs !== slots[slotIndex - 1].endMs) return false;
  }
  return true;
}
