/**
 * The P1 for an inverter stuck off the grid: it still reads machine model 151 (Off-Grid III, grid relay
 * open) stuck_p1_after_minutes after 050 was wanted, and a P3 once it reads 050 again. The decision is
 * gridOffDecisions.ts's trackStuckOffGrid; this file only words and raises it.
 */
import type { AlertManager } from "../alerting/alertManager.ts";
import { errorLog } from "../utilities/logging.ts";

/**
 * One key per episode, by its onset: the manager's per-key cooldown (30 min, kept across restarts) must not
 * swallow a second episode, e.g. still stuck after a controller restart
 */
function stuckOffGridAlertKey(episodeOnsetMs: number): string {
  return `grid-off-stuck:${episodeOnsetMs}`;
}

export function raiseStuckOffGrid(
  raise: AlertManager["raise"],
  {
    episodeOnsetMs,
    stuckForMs,
    switchBackSends,
    why,
  }: { episodeOnsetMs: number; stuckForMs: number; switchBackSends: number; why: string }
): void {
  void raise({
    key: stuckOffGridAlertKey(episodeOnsetMs),
    severity: "P1",
    title: "Inverter stuck off the grid (Off-Grid III)",
    message:
      `The inverter still reads machine model 151 (grid relay open) ${Math.round(stuckForMs / 60_000)} min after ` +
      `normal 050 was wanted (${why}); ${switchBackSends} DM050 sent so far, resent with back-off. Buy windows ` +
      "can't charge and the grid only takes the house on an overload or a flat battery. Set the operation mode " +
      "back on the inverter's display, or power-cycle it.",
  }).catch(error => errorLog("Grid off: raising the stuck-off-grid P1 failed", error));
}

export function raiseStuckOffGridResolved(
  raise: AlertManager["raise"],
  { episodeOnsetMs, stuckForMs }: { episodeOnsetMs: number; stuckForMs: number }
): void {
  void raise({
    key: `${stuckOffGridAlertKey(episodeOnsetMs)}:resolved`,
    severity: "P3",
    title: "Resolved: Inverter stuck off the grid",
    message: `The inverter reads 050 (normal hybrid) again, after ${Math.round(stuckForMs / 60_000)} min stuck on 151.`,
  }).catch(error => errorLog("Grid off: raising the stuck-off-grid resolve notice failed", error));
}
