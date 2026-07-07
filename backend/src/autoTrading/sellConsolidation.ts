/**
 * Defragment the greedy's sell allocation (called by generatePlan after the bridge pass).
 *
 * Why it exists: under a binding reserve budget the greedy takes the top-priced 15-min slots,
 * which zigzagging 15-min day-ahead prices scatter into combs — and the ramp model amplifies
 * that: near budget exhaustion a full-power contiguous slot no longer fits while an isolated
 * (ramp-crippled, ~2/3 energy) slot still does, so holes win systematically (the "15 min Loch"
 * schedules of 2026-07-07/08). Local-search moves repair this; each is re-simulated and only
 * applied when feasible and the optimizer objective (revenue minus restart penalties) improves:
 *   - fill a one-slot hole between runs, alone (full or reduced power) or funded by dropping the
 *     cheapest edge slot of another run. Like the pre-existing bridge pass, fills may cross a
 *     below-min-spot dip — the simulation prices that against the reclaimed restart penalty.
 *   - merge two neighbouring runs by relocating one flush against the other (covers single-slot
 *     teeth as the degenerate case) — öre of price cost against whole SEK of penalty
 *   - extend a run edge at reduced power, so a fractional leftover budget still gets sold instead
 *     of spawning a remote ramp-crippled tooth (pure edge adds must clear min_gain_sek_per_slot
 *     and the min sell spot, like the greedy's adds)
 * plus a final cosmetic pass that equalizes power across each chain's post-ramp body so the
 * schedule collapses to a couple of entries instead of a power staircase.
 */

import { objectiveSek, simulate, slotTradableForSell } from "./simulate.ts";
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

/** Mutates sellW in place; returns the simulation state it converged on. */
export function consolidateSellSlots(
  input: PlannerInput,
  slots: Slot[],
  sellW: number[],
  buyW: number[],
  tailSpot: number,
  feasible: (result: SimResult) => boolean,
  current: SimResult
): SimResult {
  const search: SearchState = { input, slots, sellW, buyW, tailSpot, feasible, current, trialsLeft: 400 };
  const { min_sell_spot_sek_per_kwh } = input.knobs;

  let movesLeft = 24;
  outer: while (movesLeft-- > 0 && search.trialsLeft > 0) {
    const runs = computeRuns(search);
    if (!runs.length) break;

    // 1. One-slot holes between consecutive runs: fill, else fund by dropping the cheapest edge
    //    slot of some run (never a slot adjacent to the hole — that just moves it)
    const edges = runs
      .flatMap(run => (run.length === 1 ? [run[0]] : [run[0], run[run.length - 1]]))
      .sort((a, b) => (slots[a].spot ?? 0) - (slots[b].spot ?? 0));
    for (let runIdx = 0; runIdx + 1 < runs.length; runIdx++) {
      const hole = runs[runIdx][runs[runIdx].length - 1] + 1;
      if (runs[runIdx + 1][0] !== hole + 1 || !fillableSlot(search, hole)) continue;
      if (!timeAdjacent(search, hole - 1, hole) || !timeAdjacent(search, hole, hole + 1)) continue;
      if (tryFill(search, undefined, hole)) continue outer;
      for (const edge of edges) {
        if (Math.abs(edge - hole) <= 1) continue;
        if (tryFill(search, edge, hole)) continue outer;
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
      ].sort((a, b) => a.moved.length - b.moved.length);
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
        if (tryFill(search, undefined, target)) continue outer;
      }
    }
    break;
  }

  equalizeChainPower(search);
  return search.current;
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

/** Simulate the current sellW; keep it (and return true) when feasible and the objective improves enough. */
function acceptTrial(search: SearchState, minGainSek: number): boolean {
  if (search.trialsLeft-- <= 0) return false;
  const trial = simulate(search.input, search.slots, search.sellW, search.buyW, search.tailSpot);
  if (search.feasible(trial) && objectiveSek(trial) > objectiveSek(search.current) + Math.max(minGainSek, 1e-6)) {
    search.current = trial;
    return true;
  }
  return false;
}

/**
 * Add one slot (full power first, reduced captures fractional budgets), optionally funded by
 * dropping another. Funded moves are ~energy-neutral and need no extra gain; pure adds clear the
 * same min-gain bar as the greedy's.
 */
function tryFill(search: SearchState, dropIndex: number | undefined, addIndex: number): boolean {
  const savedDropWatts = dropIndex !== undefined ? search.sellW[dropIndex] : 0;
  if (dropIndex !== undefined) search.sellW[dropIndex] = 0;
  for (const factor of [1, 2 / 3, 1 / 2, 1 / 3]) {
    search.sellW[addIndex] = Math.round(search.input.knobs.max_sell_power_watts * factor);
    if (acceptTrial(search, dropIndex === undefined ? search.input.knobs.min_gain_sek_per_slot : 0)) return true;
  }
  search.sellW[addIndex] = 0;
  if (dropIndex !== undefined) search.sellW[dropIndex] = savedDropWatts;
  return false;
}

/**
 * Relocate a whole run onto a target position. The move changes ramp state (e.g. a crippled
 * isolated slot becomes a full-power run member), so scaled-down watts are also tried — that
 * lets an energy-equivalent relocation through a binding budget.
 */
function tryRelocateRun(search: SearchState, run: number[], targets: number[]): boolean {
  const savedWatts = run.map(slotIndex => search.sellW[slotIndex]);
  for (const slotIndex of run) search.sellW[slotIndex] = 0;
  if (targets.every(target => fillableSlot(search, target))) {
    for (const factor of [1, 2 / 3, 1 / 2, 1 / 3]) {
      targets.forEach((target, offset) => (search.sellW[target] = Math.round(savedWatts[offset] * factor)));
      if (acceptTrial(search, 0)) return true;
    }
    for (const target of targets) search.sellW[target] = 0;
  }
  run.forEach((slotIndex, offset) => (search.sellW[slotIndex] = savedWatts[offset]));
  return false;
}

/**
 * Equalize power across each chain's post-ramp body: same energy (mean rounded down), ± öre of
 * revenue, and the schedule collapses to a couple of entries instead of the power staircase
 * reduced-power fills leave behind. Slots still inside the ramp window keep their power — the
 * ramp caps their export, so averaging power away from them loses real energy.
 */
function equalizeChainPower(search: SearchState) {
  for (const run of computeRuns(search)) {
    let offsetMinutes = 0;
    const body: number[] = [];
    for (const slotIndex of run) {
      if (offsetMinutes >= search.input.knobs.sell_ramp_minutes) body.push(slotIndex);
      offsetMinutes += search.slots[slotIndex].durationH * 60;
    }
    if (body.length < 2 || new Set(body.map(slotIndex => search.sellW[slotIndex])).size <= 1) continue;
    if (search.trialsLeft-- <= 0) break;
    const savedWatts = body.map(slotIndex => search.sellW[slotIndex]);
    const meanWatts = Math.floor(savedWatts.reduce((a, b) => a + b, 0) / body.length / 100) * 100;
    for (const slotIndex of body) search.sellW[slotIndex] = meanWatts;
    const trial = simulate(search.input, search.slots, search.sellW, search.buyW, search.tailSpot);
    if (search.feasible(trial) && objectiveSek(trial) >= objectiveSek(search.current) - 0.1 * body.length) {
      search.current = trial;
    } else {
      body.forEach((slotIndex, offset) => (search.sellW[slotIndex] = savedWatts[offset]));
    }
  }
}
