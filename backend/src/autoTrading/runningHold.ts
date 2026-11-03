/**
 * A hold of ours that is running at nowMs, in a re-plan that keeps the running windows (the opportunistic and
 * the guard re-plans, replanAroundRunningWindows.ts). Such a re-plan keeps every other running window whole,
 * and that froze a hold, up to ~9 h of it, at whatever the plan that wrote it had decided: no re-plan could
 * end it when the battery's energy stopped being worth keeping, or hold on when it became worth more.
 *
 * So a running hold is kept only through the current quarter, as written: the hold pass then can't flap it
 * from one re-plan to the next, and a window doesn't change mid-quarter. From the next quarter on it is
 * planned like any window of ours that hasn't started (holdAllocation.ts): the plan holds on (still one
 * window, keyed where the hold started), stops it at the end of the quarter, or holds past where it was going
 * to end. The run it continues counts as one window that has already started: hold_min_window_minutes,
 * which keeps short windows out because each costs an EDB1/EDB0 pair, doesn't cut it short (its EDB1 already
 * went out), and hold_bridge_minutes bridges from it like from any hold.
 *
 * Only while the plan models holds (simulate.ts' holdsModelled) and prices the current quarter: otherwise the
 * plan couldn't value holding on, and the running hold is planned around as given, as before. Pure.
 */

import { holdsModelled } from "./simulate.ts";
import { terminalValuationFor } from "./terminalValue.ts";
import { isHoldWindow } from "./plannerKnobBounds.ts";
import { SLOT_MS } from "./slotDuration.ts";
import type { PlannerInput, Slot } from "./planner.types.ts";

export type ResolvedRunningHold = {
  /**
   * The input to plan with: its fixedBuys hold the running hold through the current quarter when it is
   * re-planned (and runningHold stays set), or whole when it isn't (and runningHold is cleared)
   */
  input: PlannerInput;
  reshapesRunningHold: boolean;
};

/** Main: whether this plan re-plans input.runningHold from the next quarter on, and the input to plan with */
export function resolveRunningHold(input: PlannerInput): ResolvedRunningHold {
  const runningHold = input.runningHold;
  if (!runningHold) return { input, reshapesRunningHold: false };
  const currentQuarter = input.prices.find(
    price => price.startMs <= input.nowMs && price.startMs + SLOT_MS > input.nowMs
  );
  const endEnergySekPerKwh = terminalValuationFor(input).valuation?.endEnergySekPerKwh ?? 0;
  const reshapes =
    currentQuarter !== undefined &&
    runningHold.startMs <= input.nowMs &&
    runningHold.endMs > input.nowMs &&
    isHoldWindow(runningHold.watts, input.knobs.hold_enabled) &&
    holdsModelled(input.knobs, { endEnergySekPerKwh });
  if (!reshapes) {
    return {
      input: { ...input, runningHold: undefined, fixedBuys: [...input.fixedBuys, runningHold] },
      reshapesRunningHold: false,
    };
  }
  const currentQuarterEndMs = currentQuarter.startMs + SLOT_MS;
  return {
    input: {
      ...input,
      fixedBuys: [...input.fixedBuys, { ...runningHold, endMs: Math.min(runningHold.endMs, currentQuarterEndMs) }],
    },
    reshapesRunningHold: true,
  };
}

/**
 * Whether the slot is the current quarter of a running hold the plan re-plans (resolveRunningHold): it holds
 * there as a fixed window, and a hold run through it continues that hold. Slot 0 is the current quarter then,
 * as resolveRunningHold only re-plans with the current quarter priced.
 */
export function isRunningHoldSlot(input: Pick<PlannerInput, "runningHold">, slotIndex: number): boolean {
  return slotIndex === 0 && input.runningHold !== undefined;
}

/** The plan note on a re-planned running hold: when it started, and until when it now holds */
export function runningHoldNote(
  input: Pick<PlannerInput, "runningHold">,
  /** The plan's hold windows, ordered by start */
  holdWindows: { startMs: number; endMs: number; slotIndexes: number[] }[],
  slots: Slot[]
): string | undefined {
  const runningHold = input.runningHold;
  if (!runningHold) return undefined;
  // A power step (hold_power_watts changed since it started) splits the hold into windows that meet
  let endMs = slots[0]?.endMs ?? runningHold.endMs;
  for (const window of holdWindows) if (window.startMs === endMs || window.slotIndexes[0] === 0) endMs = window.endMs;
  const writtenEnd =
    endMs === runningHold.endMs
      ? "as written"
      : `${endMs < runningHold.endMs ? "instead of" : "past"} ${new Date(runningHold.endMs).toISOString()}`;
  return `Running hold since ${new Date(runningHold.startMs).toISOString()} re-planned after the current quarter: it holds until ${new Date(endMs).toISOString()} (${writtenEnd})`;
}
