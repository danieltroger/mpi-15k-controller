/**
 * The P2 for energy-distribution settings that still don't read back as the profile
 * grid_off.settings_restore_p2_after_minutes into a restore episode, and a P3 once they do. The decision is
 * energyDistributionRestoreDecisions.ts's nextRestoreStep; this file only words and raises it.
 */
import type { AlertManager } from "../alerting/alertManager.ts";
import { errorLog } from "../utilities/logging.ts";
import type { EnergyDistributionFieldMismatch } from "./gridOff.types.ts";
import { describeMismatches } from "./energyDistributionProfile.ts";

/**
 * One key per episode, by its onset: the manager's per-key cooldown (30 min, kept across restarts) must not
 * swallow the next episode's page
 */
function restoreAlertKey(episodeOnsetMs: number): string {
  return `grid-off-settings-restore:${episodeOnsetMs}`;
}

export function raiseRestoreNotLanded(
  raise: AlertManager["raise"],
  {
    episodeOnsetMs,
    nowMs,
    sendRounds,
    mismatches,
  }: {
    episodeOnsetMs: number;
    nowMs: number;
    sendRounds: number;
    /** undefined: no HECS readback since the switch to judge */
    mismatches: readonly EnergyDistributionFieldMismatch[] | undefined;
  }
): void {
  const state = mismatches
    ? `the inverter still reads ${describeMismatches(mismatches)}`
    : "no HECS readback has come since, so the reset settings can't be checked";
  void raise({
    key: restoreAlertKey(episodeOnsetMs),
    severity: "P2",
    title: "Inverter settings not restored after the machine model change",
    message:
      `${Math.round((nowMs - episodeOnsetMs) / 60_000)} min after the switch back to normal (050) ${state}; ` +
      `${sendRounds} round(s) of setters sent, retried with back-off. A DM change resets them to the factory ` +
      "defaults: with battery discharge to the loads off, the house runs from the grid. Set them on the inverter's " +
      "display, or press Restore normal settings on the System page.",
  }).catch(error => errorLog("Grid off: raising the settings-restore P2 failed", error));
}

export function raiseRestoreLandedAfterP2(
  raise: AlertManager["raise"],
  { episodeOnsetMs, nowMs }: { episodeOnsetMs: number; nowMs: number }
): void {
  void raise({
    key: `${restoreAlertKey(episodeOnsetMs)}:resolved`,
    severity: "P3",
    title: "Resolved: Inverter settings restored",
    message: `The energy-distribution settings read back as the profile again, ${Math.round((nowMs - episodeOnsetMs) / 60_000)} min after the switch back to 050.`,
  }).catch(error => errorLog("Grid off: raising the settings-restore resolve notice failed", error));
}
