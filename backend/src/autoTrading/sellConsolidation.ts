/**
 * Local-search cleanup of the greedy's sell allocation (called by generatePlan after the bridge
 * pass). A fragmented schedule is fine when it genuinely prices better — a stop/start costs
 * nothing but the modeled ramp — but the greedy's one-slot-at-a-time accept order also strands
 * revenue it can't see: a hole whose fill would recover a ramp restart, and a scattered slot that
 * a relocation turns into run time. The greedy itself already sells the last fraction of a budget
 * at reduced power in the best remaining quarter (reducedSellPower.ts), often as a lone tooth;
 * whether merging that tooth into a run pays is for the moves below to price. Each move is
 * re-simulated and only applied when feasible and simulated revenue strictly improves (a move that
 * joins runs: see the tolerance below):
 *   - fill a one-slot hole between runs, alone (at the largest power that fits; a pure add clears
 *     min_gain_sek_per_slot like the greedy's) or funded by dropping the cheapest edge slot of
 *     another run. Like the pre-existing bridge pass, fills may cross a below-min-spot dip — the
 *     simulation prices the dip against the recovered ramp.
 *   - merge two neighbouring runs by relocating one flush against the other (covers single-slot
 *     teeth as the degenerate case) when the ramp recovery beats the price difference. The ramp
 *     is a rate (feedInRamp.ts), so a low-power slot only partly pre-ramps a full-power neighbour:
 *     the step-up still climbs.
 *   - extend a run edge at the largest power that fits, so budget the moves above free up (a
 *     recovered ramp restart, a dropped short run) still gets sold instead of spawning a remote
 *     tooth (pure edge adds must clear min_gain_sek_per_slot and the min sell spot, like the
 *     greedy's adds)
 * plus a final cosmetic pass that equalizes power across each chain's post-ramp body so the
 * schedule collapses to a couple of entries instead of a power staircase (≤ 0.1 SEK tolerated).
 * A run shorter than min_window_minutes would be dropped when the windows are merged, budget and
 * all, so it is dropped here instead and the moves get another round to spend what it frees.
 *
 * The energy-neutral moves (funded fills, relocations) may cost up to
 * fragmentation_tolerance_sek_per_window per run they remove. A comb of single quarters on
 * zigzagging prices "wins" by about the ramp model's own error: at peak prices each 15 kW restart is
 * over-credited ~90 Wh (planned at 1.5 kW/min, measured 1.4), while every extra run costs two
 * window-edge writes and a ramp restart for real. No move adds a run, so the allowance only ever
 * buys fewer of them, and movesLeft bounds it.
 *
 * Reduced powers never go below min_sell_power_watts. Full power may always be tried, so a minimum
 * at or above max_sell_power_watts switches the reduced ones off.
 */

import { simulate, slotTradableForSell } from "./simulate.ts";
import { sellRampMinutesBetween } from "./feedInRamp.ts";
import { largestFeasibleSellPower, SELL_POWER_STEP_WATTS } from "./reducedSellPower.ts";
import type { PlannerInput, SimResult, Slot } from "./planner.types.ts";

/**
 * Shared mutable state of the local search. Helpers mutate sellW (the candidate schedule),
 * current (the accepted simulation) and trialsLeft (the simulate-call budget) through this —
 * explicit at every call site instead of hidden in closures.
 */
type SearchState = {
  input: PlannerInput;
  slots: Slot[];
  sellW: number[];
  buyW: number[];
  tailSpot: number;
  feasible: (result: SimResult) => boolean;
  current: SimResult;
  trialsLeft: number;
};

/** Powers a fill or relocation tries, as fractions of its full power, descending */
const POWER_FACTORS = [1, 2 / 3, 1 / 2, 1 / 3];

/**
 * A scaled power on the same 100 W grid the greedy's search uses, so windows read as round numbers
 * (⅓ of a 4.6 kW run would otherwise be written as 1533 W). The callers check the minimum after
 * rounding, so it never takes a power under min_sell_power_watts.
 */
function roundedSellWatts(watts: number): number {
  return Math.round(watts / SELL_POWER_STEP_WATTS) * SELL_POWER_STEP_WATTS;
}

/**
 * Mutates sellW in place; returns the simulation state it converged on, and how many runs shorter
 * than min_window_minutes it dropped.
 */
export function consolidateSellSlots(
  input: PlannerInput,
  slots: Slot[],
  sellW: number[],
  buyW: number[],
  tailSpot: number,
  feasible: (result: SimResult) => boolean,
  current: SimResult
): { result: SimResult; droppedShortRuns: number } {
  const search: SearchState = { input, slots, sellW, buyW, tailSpot, feasible, current, trialsLeft: 400 };
  runConsolidationMoves(search);
  // A run shorter than min_window_minutes is dropped when the windows are merged, and its budget
  // with it. Drop it here instead, where the moves can still spend what it frees on the runs that
  // stay (a funded fill can shorten a run below the minimum, hence a second round).
  let droppedShortRuns = 0;
  for (let round = 0; round < 2; round++) {
    const droppedThisRound = dropShortRuns(search);
    if (!droppedThisRound) break;
    droppedShortRuns += droppedThisRound;
    runConsolidationMoves(search);
  }
  equalizeChainPower(search);
  return { result: search.current, droppedShortRuns };
}

/** The local search's moves (see the header), applied until none improves or a budget runs out */
function runConsolidationMoves(search: SearchState) {
  const { slots } = search;
  const { min_sell_spot_sek_per_kwh } = search.input.knobs;
  let movesLeft = 24;
  outer: while (movesLeft-- > 0 && search.trialsLeft > 0) {
    const runs = computeRuns(search);
    if (!runs.length) break;

    // 1. One-slot holes between consecutive runs: fill, else fund by dropping the cheapest edge
    //    slot of some run (never a slot adjacent to the hole — that just moves it)
    const edges = runs
      .flatMap(run => (run.length === 1 ? [run[0]] : [run[0], run[run.length - 1]]))
      .sort((firstEdge, secondEdge) => (slots[firstEdge].spot ?? 0) - (slots[secondEdge].spot ?? 0));
    for (let runIdx = 0; runIdx + 1 < runs.length; runIdx++) {
      const hole = runs[runIdx][runs[runIdx].length - 1] + 1;
      if (runs[runIdx + 1][0] !== hole + 1 || !fillableSlot(search, hole)) continue;
      if (!timeAdjacent(search, hole - 1, hole) || !timeAdjacent(search, hole, hole + 1)) continue;
      if (tryAdd(search, hole)) continue outer;
      for (const edge of edges) {
        if (Math.abs(edge - hole) <= 1) continue;
        if (tryFundedFill(search, edge, hole)) continue outer;
      }
    }

    // 2. Merge neighbouring runs by relocating one flush against the other — cheaper relocation
    //    (fewer slots moved) first
    for (let runIdx = 0; runIdx + 1 < runs.length; runIdx++) {
      const before = runs[runIdx];
      const after = runs[runIdx + 1];
      const beforeEnd = before[before.length - 1];
      if (after[0] - beforeEnd < 2) continue;
      // A flush relocation only exists when the whole span sits on one uninterrupted 15-min grid
      let spanContiguous = true;
      for (let idx = beforeEnd; idx < after[0] && spanContiguous; idx++) {
        spanContiguous = timeAdjacent(search, idx, idx + 1);
      }
      if (!spanContiguous) continue;
      const attempts = [
        { moved: before, targets: before.map((_, offset) => after[0] - before.length + offset) },
        { moved: after, targets: after.map((_, offset) => beforeEnd + 1 + offset) },
      ].sort((firstAttempt, secondAttempt) => firstAttempt.moved.length - secondAttempt.moved.length);
      for (const { moved, targets } of attempts) {
        if (tryRelocateRun(search, moved, targets)) continue outer;
      }
    }

    // 3. Extend run edges at reduced power — mops up a leftover budget fraction
    for (const run of runs) {
      const first = run[0];
      const last = run[run.length - 1];
      for (const target of [first - 1, last + 1]) {
        if (!fillableSlot(search, target)) continue;
        if (!(target < first ? timeAdjacent(search, target, first) : timeAdjacent(search, last, target))) continue;
        if ((slots[target].spot ?? 0) < min_sell_spot_sek_per_kwh) continue;
        if (tryAdd(search, target)) continue outer;
      }
    }
    break;
  }
}

/**
 * Zero every run shorter than min_window_minutes (judged like mergeAcceptedSlots: whole slots) and
 * re-simulate. Selling less only raises the SOC, so the result stays feasible. Returns how many.
 */
function dropShortRuns(search: SearchState): number {
  const shortRuns = computeRuns(search).filter(
    run =>
      (search.slots[run[run.length - 1]].endMs - search.slots[run[0]].startMs) / 60_000 <
      search.input.knobs.min_window_minutes
  );
  if (!shortRuns.length) return 0;
  for (const run of shortRuns) for (const slotIndex of run) search.sellW[slotIndex] = 0;
  search.current = simulate(search.input, search.slots, search.sellW, search.buyW, search.tailSpot);
  return shortRuns.length;
}

/** Contiguous runs of accepted sell slots, ascending in time. */
function computeRuns(search: SearchState): number[][] {
  const runs: number[][] = [];
  for (let slotIndex = 0; slotIndex < search.slots.length; slotIndex++) {
    if (search.sellW[slotIndex] <= 0) continue;
    const lastRun = runs[runs.length - 1];
    const previous = lastRun?.[lastRun.length - 1];
    if (previous !== undefined && timeAdjacent(search, previous, slotIndex)) lastRun.push(slotIndex);
    else runs.push([slotIndex]);
  }
  return runs;
}

/** May the search put NEW selling into this slot? */
function fillableSlot(search: SearchState, slotIndex: number): boolean {
  const slot = search.slots[slotIndex];
  return (
    slot !== undefined &&
    search.sellW[slotIndex] === 0 &&
    search.buyW[slotIndex] === 0 &&
    slotTradableForSell(slot, search.input.sellVetoWindows)
  );
}

function timeAdjacent(search: SearchState, earlier: number, later: number): boolean {
  const earlierSlot = search.slots[earlier];
  const laterSlot = search.slots[later];
  return earlierSlot !== undefined && laterSlot !== undefined && laterSlot.startMs === earlierSlot.endMs;
}

/**
 * Simulate the current sellW; keep it (and return true) when feasible and revenue moves by at least
 * minGainSek: 0 means a strict improvement, a negative value is a merge allowance (mergeAllowanceSek).
 */
function acceptTrial(search: SearchState, minGainSek: number): boolean {
  if (search.trialsLeft-- <= 0) return false;
  const trial = simulate(search.input, search.slots, search.sellW, search.buyW, search.tailSpot);
  const requiredGainSek = minGainSek === 0 ? 1e-6 : minGainSek;
  if (search.feasible(trial) && trial.revenueSek >= search.current.revenueSek + requiredGainSek) {
    search.current = trial;
    return true;
  }
  return false;
}

/**
 * The minimum gain for an energy-neutral move (a funded fill, a relocation): a strict improvement,
 * or — when the move as it now stands in sellW joins runs — a loss of up to
 * fragmentation_tolerance_sek_per_window per run removed. Moves never add runs, so the tolerance
 * can only ever pay for fewer of them.
 */
function mergeAllowanceSek(search: SearchState, runsBefore: number): number {
  const runsRemoved = runsBefore - computeRuns(search).length;
  return runsRemoved > 0 ? -search.input.knobs.fragmentation_tolerance_sek_per_window * runsRemoved : 0;
}

/**
 * Add one slot with nothing dropped to pay for it: full power if that fits, else the largest power
 * that does (reducedSellPower.ts), so a leftover budget fraction is sold to the 100 W step rather
 * than at the nearest of four fixed fractions. Clears the same min-gain bar as the greedy's adds.
 */
function tryAdd(search: SearchState, addIndex: number): boolean {
  const { max_sell_power_watts, min_sell_power_watts, min_gain_sek_per_slot } = search.input.knobs;
  if (search.trialsLeft-- <= 0) return false;
  search.sellW[addIndex] = max_sell_power_watts;
  let trial: SimResult | undefined = simulate(search.input, search.slots, search.sellW, search.buyW, search.tailSpot);
  if (!search.feasible(trial)) {
    trial = largestFeasibleSellPower(search, [addIndex], min_sell_power_watts, max_sell_power_watts)?.result;
  }
  if (trial && trial.revenueSek >= search.current.revenueSek + Math.max(min_gain_sek_per_slot, 1e-6)) {
    search.current = trial;
    return true;
  }
  search.sellW[addIndex] = 0;
  return false;
}

/**
 * Add one slot funded by dropping another (full power first, then fixed fractions). Funded moves
 * are ~energy-neutral and need no extra gain; one that joins runs may even cost the merge allowance.
 */
function tryFundedFill(search: SearchState, dropIndex: number, addIndex: number): boolean {
  const { max_sell_power_watts, min_sell_power_watts } = search.input.knobs;
  const runsBefore = computeRuns(search).length;
  const savedDropWatts = search.sellW[dropIndex];
  search.sellW[dropIndex] = 0;
  for (const factor of POWER_FACTORS) {
    const watts = factor < 1 ? roundedSellWatts(max_sell_power_watts * factor) : max_sell_power_watts;
    if (factor < 1 && watts < min_sell_power_watts) break;
    search.sellW[addIndex] = watts;
    if (acceptTrial(search, mergeAllowanceSek(search, runsBefore))) return true;
  }
  search.sellW[addIndex] = 0;
  search.sellW[dropIndex] = savedDropWatts;
  return false;
}

/**
 * Relocate a whole run onto a target position. The move changes ramp state (e.g. a crippled
 * isolated slot becomes a full-power run member), so scaled-down watts are also tried — that
 * lets an energy-equivalent relocation through a binding budget.
 */
function tryRelocateRun(search: SearchState, run: number[], targets: number[]): boolean {
  const runsBefore = computeRuns(search).length;
  const savedWatts = run.map(slotIndex => search.sellW[slotIndex]);
  for (const slotIndex of run) search.sellW[slotIndex] = 0;
  if (targets.every(target => fillableSlot(search, target))) {
    for (const factor of POWER_FACTORS) {
      const scaledWatts = savedWatts.map(watts => (factor < 1 ? roundedSellWatts(watts * factor) : watts));
      if (factor < 1 && Math.min(...scaledWatts) < search.input.knobs.min_sell_power_watts) break;
      targets.forEach((target, offset) => (search.sellW[target] = scaledWatts[offset]));
      if (acceptTrial(search, mergeAllowanceSek(search, runsBefore))) return true;
    }
    for (const target of targets) search.sellW[target] = 0;
  }
  run.forEach((slotIndex, offset) => (search.sellW[slotIndex] = savedWatts[offset]));
  return false;
}

/**
 * Equalize power across each chain's post-ramp body: same energy (mean rounded to the nearest
 * 100 W, so rounding costs at most ±öre), and the schedule collapses to a couple of entries
 * instead of the power staircase reduced-power fills leave behind. Purely cosmetic, so the
 * accepted revenue loss is capped flat at 0.1 SEK regardless of chain length — a chain whose
 * internal price gradient makes equal power genuinely costlier keeps its staircase, and so does one
 * that tracks a binding floor (a morning that sells rising PV with the SOC on the floor: its steps
 * are setpoint writes in one mode, not restarts, and flattening it would give real money away).
 * Slots that start while the run's initial ramp (from 0 to its first slot's power, at the ramp
 * rate) is still climbing keep their power — the ramp caps their export, so averaging power away
 * from them loses real energy. A mid-run step-up inside the body ramps too; the simulation prices
 * whether flattening it pays.
 */
function equalizeChainPower(search: SearchState) {
  const { knobs } = search.input;
  for (const run of computeRuns(search)) {
    const initialRampMinutes = sellRampMinutesBetween(knobs, 0, search.sellW[run[0]]);
    let offsetMinutes = 0;
    const body: number[] = [];
    for (const slotIndex of run) {
      if (offsetMinutes >= initialRampMinutes) body.push(slotIndex);
      offsetMinutes += search.slots[slotIndex].durationH * 60;
    }
    if (body.length < 2 || new Set(body.map(slotIndex => search.sellW[slotIndex])).size <= 1) continue;
    if (search.trialsLeft-- <= 0) break;
    const savedWatts = body.map(slotIndex => search.sellW[slotIndex]);
    const roundedMeanWatts = roundedSellWatts(savedWatts.reduce((sum, watts) => sum + watts, 0) / body.length);
    // Rounding never takes it below the body's lowest power, so it stays ≥ min_sell_power_watts
    const meanWatts = Math.max(roundedMeanWatts, Math.min(...savedWatts));
    for (const slotIndex of body) search.sellW[slotIndex] = meanWatts;
    let trial: SimResult | undefined = simulate(search.input, search.slots, search.sellW, search.buyW, search.tailSpot);
    if (!search.feasible(trial)) {
      // The mean keeps the setpoints' energy, but flattening also drops the step-ups' ramps, so the
      // body can deliver more than the budget allows: then the largest equal power that fits, from
      // the body's lowest step up (≤ 9 simulations; nothing fits → the staircase stays)
      trial = largestFeasibleSellPower(search, body, Math.min(...savedWatts), meanWatts)?.result;
    }
    if (trial && trial.revenueSek >= search.current.revenueSek - 0.1) {
      search.current = trial;
    } else {
      body.forEach((slotIndex, offset) => (search.sellW[slotIndex] = savedWatts[offset]));
    }
  }
}
