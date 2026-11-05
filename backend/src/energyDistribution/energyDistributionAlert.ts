/**
 * The P2 for a managed energy-distribution field that still differs from its config profile
 * inverter_energy_distribution.p2_after_minutes after it was first seen, and a P3 once it reads back as the
 * profile. The decision is energyDistributionEnforcementDecisions.ts's nextEnforcementStep; this file only
 * words and raises it.
 */
import type { AlertManager } from "../alerting/alertManager.ts";
import { errorLog } from "../utilities/logging.ts";
import type { EnergyDistributionFieldDivergence } from "./energyDistribution.types.ts";
import { describeDivergences } from "./energyDistributionProfile.ts";

/**
 * One key per episode, by its onset: the manager's per-key cooldown (30 min, kept across restarts) must not
 * swallow the next episode's page
 */
function divergenceAlertKey(episodeOnsetMs: number): string {
  return `energy-distribution-divergence:${episodeOnsetMs}`;
}

export function raiseDivergenceNotLanded(
  raise: AlertManager["raise"],
  {
    episodeOnsetMs,
    nowMs,
    sendRounds,
    divergences,
    waitingReason,
  }: {
    episodeOnsetMs: number;
    nowMs: number;
    sendRounds: number;
    /** undefined: no usable readback to say (see waitingReason) */
    divergences: readonly EnergyDistributionFieldDivergence[] | undefined;
    waitingReason: string | undefined;
  }
): void {
  const state = divergences
    ? `the inverter still reads ${describeDivergences(divergences)}`
    : `it can't be checked (${waitingReason ?? "no usable readback"})`;
  void raise({
    key: divergenceAlertKey(episodeOnsetMs),
    severity: "P2",
    title: "Inverter energy settings differ from the config",
    message:
      `${Math.round((nowMs - episodeOnsetMs) / 60_000)} min after a managed energy-distribution setting first ` +
      `differed from inverter_energy_distribution, ${state}; ${sendRounds} round(s) of setters sent, retried on ` +
      "every change of the machine model, working mode or HECS and every 10 min. With battery discharge to the " +
      "loads off the house runs from the grid. Set it on the inverter's display, or mark the field unmanaged.",
  }).catch(error => errorLog("Energy distribution: raising the divergence P2 failed", error));
}

export function raiseDivergenceLandedAfterP2(
  raise: AlertManager["raise"],
  { episodeOnsetMs, nowMs }: { episodeOnsetMs: number; nowMs: number }
): void {
  void raise({
    key: `${divergenceAlertKey(episodeOnsetMs)}:resolved`,
    severity: "P3",
    title: "Resolved: Inverter energy settings differ from the config",
    message: `Every managed energy-distribution setting reads as the config again, ${Math.round((nowMs - episodeOnsetMs) / 60_000)} min after the difference was first seen.`,
  }).catch(error => errorLog("Energy distribution: raising the divergence resolve notice failed", error));
}
