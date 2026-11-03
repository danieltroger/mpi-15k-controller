/**
 * The P1 for an inverter stuck off the grid: it still reads machine model 151 (Off-Grid III, grid relay
 * open) stuck_p1_after_minutes after 050 was wanted, and a P3 once it reads 050 again. The decision is
 * gridOffDecisions.ts's trackStuckOffGrid; this file only words and raises it.
 */
import type { AlertManager } from "../alerting/alertManager.ts";
import { errorLog } from "../utilities/logging.ts";

const STUCK_OFF_GRID_ALERT_KEY = "grid-off-stuck";

export function raiseStuckOffGrid(
  raise: AlertManager["raise"],
  { stuckForMs, switchBackSends, why }: { stuckForMs: number; switchBackSends: number; why: string }
): void {
  void raise({
    key: STUCK_OFF_GRID_ALERT_KEY,
    severity: "P1",
    title: "Inverter stuck off the grid (Off-Grid III)",
    message:
      `The inverter still reads machine model 151 (grid relay open) ${Math.round(stuckForMs / 60_000)} min after ` +
      `normal 050 was wanted (${why}); ${switchBackSends} DM050 sent so far, resent with back-off. Buy windows ` +
      "can't charge and the grid only takes the house on an overload or a flat battery. Set the operation mode " +
      "back on the inverter's display, or power-cycle it.",
  }).catch(error => errorLog("Grid off: raising the stuck-off-grid P1 failed", error));
}

export function raiseStuckOffGridResolved(raise: AlertManager["raise"], stuckForMs: number): void {
  void raise({
    key: `${STUCK_OFF_GRID_ALERT_KEY}:resolved`,
    severity: "P3",
    title: "Resolved: Inverter stuck off the grid",
    message: `The inverter reads 050 (normal hybrid) again, after ${Math.round(stuckForMs / 60_000)} min stuck on 151.`,
  }).catch(error => errorLog("Grid off: raising the stuck-off-grid resolve notice failed", error));
}
