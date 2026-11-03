/**
 * What a planning run plans around and which of our schedule entries survive it. The opportunistic and the
 * guard re-plans keep the windows of ours running right now: a sell or a buy runs on as written, as before,
 * while a running hold is handed to the planner to re-plan from the next quarter on (runningHold.ts). The
 * other runs (daily, startup, manual, veto-clear) pass nothing running and may reshape everything. No IO.
 */

import { HOLD_CLASS_MAX_WATTS } from "./plannerKnobBounds.ts";
import { generatePlan } from "./planner.ts";
import { ownedEntriesAsWindows } from "./plannerInputs.ts";
import type { AutoTraderState } from "./autoTraderState.types.ts";
import type { FixedWindow, PlannerInput, PlanResult } from "./planner.types.ts";

type OwnedEntries = AutoTraderState["owned_entries"];

export type ReplanAroundRunningWindows = {
  /** What the plan ran on: the running windows it keeps whole as fixed windows, a running hold as runningHold */
  input: PlannerInput;
  result: PlanResult;
  /** The owned entries applyPlan keeps as they are, besides the plan's own windows */
  keepOwned: OwnedEntries;
};

/**
 * Main: plans with the running windows of ours in `running` (activeOwnedEntries, or none) kept, and says
 * which entries to keep. Throws when the plan claims to have re-planned the running hold but has no window
 * carrying it on: applying that would end the hold mid-quarter without anything having decided it.
 */
export function replanAroundRunningWindows(input: PlannerInput, running: OwnedEntries): ReplanAroundRunningWindows {
  const runningHold = runningHoldEntry(running.buying, input.knobs.hold_enabled);
  const keptWhole: OwnedEntries = {
    selling: running.selling,
    buying: Object.fromEntries(Object.entries(running.buying).filter(([key]) => key !== runningHold?.key)),
  };
  const plannedInput: PlannerInput = {
    ...input,
    fixedSells: [...input.fixedSells, ...ownedEntriesAsWindows(keptWhole.selling, "power_watts")],
    fixedBuys: [...input.fixedBuys, ...ownedEntriesAsWindows(keptWhole.buying, "charging_power")],
    ...(runningHold ? { runningHold: runningHold.window } : {}),
  };
  const result = generatePlan(plannedInput);
  if (!runningHold || !result.runningHoldReshaped) {
    // Planned around as given (or nothing was running): every running entry stays as written
    return { input: plannedInput, result, keepOwned: running };
  }
  const carriesItOn = result.buys.some(window => window.hold && window.startMs === runningHold.window.startMs);
  if (!carriesItOn) {
    throw new Error(
      `the plan re-planned the running hold ${runningHold.key} but wrote no hold window starting there (buys: ${result.buys.map(window => `${new Date(window.startMs).toISOString()}→${new Date(window.endMs).toISOString()}@${window.watts}`).join(", ")})`
    );
  }
  return { input: plannedInput, result, keepOwned: keptWhole };
}

/**
 * The buy entry of ours running now that is a hold: hold_enabled on and within the hold class, as the runtime
 * tells a hold (buying/scheduledBuyDecision.ts). Our windows don't overlap, so there is at most one.
 */
function runningHoldEntry(
  runningBuys: OwnedEntries["buying"],
  holdEnabled: boolean
): { key: string; window: FixedWindow } | undefined {
  if (!holdEnabled) return undefined;
  for (const [key, entry] of Object.entries(runningBuys)) {
    const watts = Number(entry.charging_power);
    const window = { startMs: +new Date(key), endMs: +new Date(entry.end_time), watts };
    if (watts > 0 && watts <= HOLD_CLASS_MAX_WATTS && isFinite(window.startMs) && isFinite(window.endMs)) {
      return { key, window };
    }
  }
  return undefined;
}
