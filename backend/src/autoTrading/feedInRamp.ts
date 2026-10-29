/**
 * The inverter's grid feed-in ramp as the planner models it. Feed-in climbs at a fixed rate (grid
 * safety): sell_ramp_minutes is the time from 0 to the full inverter_max_ac_output_watts, so a smaller
 * target is reached proportionally sooner and a mid-run step-up climbs too. Decreases are immediate.
 * Measured at ~1.4 kW/min whatever the target or starting level: 0 → 4.9 kW in ~3.5 min (2026-07-12),
 * 0 → 9.8 kW in ~7 min (2026-10-29), and mid-run 4.8 → 14.8 kW in ~7 min (2026-09-14) and 9.9 → 14.9 kW
 * in ~3.5 min (2026-09-24); 2026-09-14's 15 → 5 kW step-down took under a minute, command latency included.
 */

import type { FixedWindow, PlannerKnobs } from "./planner.types.ts";

/** How fast feed-in climbs, in W per minute. Infinity when the ramp is switched off (0). */
export function sellRampWattsPerMinute(knobs: PlannerKnobs): number {
  return knobs.sell_ramp_minutes > 0 ? knobs.inverter_max_ac_output_watts / knobs.sell_ramp_minutes : Infinity;
}

/** Minutes the feed-in needs to climb from fromW to toW (0 when it doesn't climb) */
export function sellRampMinutesBetween(knobs: PlannerKnobs, fromW: number, toW: number): number {
  return toW > fromW ? (toW - fromW) / sellRampWattsPerMinute(knobs) : 0;
}

/**
 * One slot of feed-in that starts at startW and heads for targetW: an increase climbs linearly at
 * rampWattsPerMinute until it reaches the target (possibly not within the slot), a decrease is
 * immediate. Returns the slot's average export and the level reached at its end, integrated exactly
 * (the curve is piecewise linear).
 */
export function rampedSlotExport(
  startW: number,
  targetW: number,
  slotMinutes: number,
  rampWattsPerMinute: number
): { averageW: number; endW: number } {
  if (targetW <= startW || slotMinutes <= 0) return { averageW: targetW, endW: targetW };
  const minutesToTarget = (targetW - startW) / rampWattsPerMinute;
  if (minutesToTarget >= slotMinutes) {
    const endW = startW + rampWattsPerMinute * slotMinutes;
    return { averageW: (startW + endW) / 2, endW };
  }
  const rampWattMinutes = ((startW + targetW) / 2) * minutesToTarget;
  const heldWattMinutes = targetW * (slotMinutes - minutesToTarget);
  return { averageW: (rampWattMinutes + heldWattMinutes) / slotMinutes, endW: targetW };
}

/**
 * The feed-in level that sell windows already running at nowMs have reached. A plan made mid-window
 * (the opportunistic replan, the guard's re-plan, a daily run that lands in a window) starts the
 * simulation's slot 0 here, not at 0: ramping a running 15 kW window from 0 again under-credits it by
 * up to ~1.25 kWh, which the planner would see as spare budget and sell. Replays the ramp over the
 * chain of schedule entries leading up to nowMs without a gap (the runtime starts a window before
 * ending the previous one, so adjacent windows feed without a dip); maxExportW caps each target the
 * way the house load caps export. 0 when nothing is feeding at nowMs.
 */
export function feedInReachedAtNow(
  sellWindows: FixedWindow[],
  nowMs: number,
  maxExportW: number,
  rampWattsPerMinute: number
): number {
  const feedingWindows = sellWindows.filter(window => window.watts > 0 && window.endMs > window.startMs);
  const coveringNow = feedingWindows.filter(window => window.startMs <= nowMs && window.endMs > nowMs);
  if (!coveringNow.length) return 0;
  let chainStartMs = Math.min(...coveringNow.map(window => window.startMs));
  // Each step moves the start strictly earlier, so this ends within one pass per window
  for (let step = 0; step < feedingWindows.length; step++) {
    const predecessors = feedingWindows.filter(window => window.startMs < chainStartMs && window.endMs >= chainStartMs);
    if (!predecessors.length) break;
    chainStartMs = Math.min(...predecessors.map(window => window.startMs));
  }
  const boundaries = [
    ...new Set([
      chainStartMs,
      nowMs,
      ...feedingWindows
        .flatMap(window => [window.startMs, window.endMs])
        .filter(boundaryMs => boundaryMs > chainStartMs && boundaryMs < nowMs),
    ]),
  ].sort((earlier, later) => earlier - later);
  let levelW = 0;
  for (let index = 0; index + 1 < boundaries.length; index++) {
    const segmentStartMs = boundaries[index];
    const segmentMinutes = (boundaries[index + 1] - segmentStartMs) / 60_000;
    const setpointW = Math.max(
      0,
      ...feedingWindows
        .filter(window => window.startMs <= segmentStartMs && window.endMs > segmentStartMs)
        .map(window => window.watts)
    );
    const targetW = Math.max(0, Math.min(setpointW, maxExportW));
    levelW = rampedSlotExport(levelW, targetW, segmentMinutes, rampWattsPerMinute).endW;
  }
  return levelW;
}
