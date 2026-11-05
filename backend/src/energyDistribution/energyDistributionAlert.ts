/**
 * The P2 for a managed energy-distribution field that still differs from its config profile
 * inverter_energy_distribution.p2_after_minutes after it was first seen, and a P3 once it reads back as the
 * profile. The decision is energyDistributionEnforcementDecisions.ts's nextEnforcementStep; this file only
 * words and raises it. Episodes aren't kept across a restart: one open then gets no P3 (and, still
 * differing, starts a new episode with its own P2).
 */
import type { AlertManager } from "../alerting/alertManager.ts";
import { errorLog } from "../utilities/logging.ts";
import { describeDivergences, ENERGY_DISTRIBUTION_FIELD_LABELS } from "./energyDistributionProfile.ts";
import {
  CHANGE_TRIGGERED_RETRIES_PER_EPISODE,
  ENFORCEMENT_FALLBACK_RETRY_MS,
  type EnforcementJudgement,
} from "./energyDistributionEnforcementDecisions.ts";

/** The fields that, off, leave the house on the grid */
const DISCHARGE_TO_LOADS_FIELDS: ReadonlySet<string> = new Set([
  "battery_discharge_to_loads_when_solar_input_normal",
  "battery_discharge_to_loads_when_solar_input_loss",
]);

export function raiseDivergenceNotLanded(
  raise: AlertManager["raise"],
  {
    episodeOnsetMs,
    nowMs,
    sendRounds,
    judged,
    waitingReason,
  }: {
    episodeOnsetMs: number;
    nowMs: number;
    sendRounds: number;
    /** undefined: no usable readback to say (see waitingReason) */
    judged: EnforcementJudgement | undefined;
    waitingReason: string | undefined;
  }
): void {
  const state = judged ? describeJudgedState(judged) : `it can't be checked (${waitingReason ?? "no usable readback"})`;
  const houseOnGridNote = judged?.divergences.some(
    divergence => DISCHARGE_TO_LOADS_FIELDS.has(divergence.field) && divergence.desired === "enabled"
  )
    ? " With battery discharge to the loads off, the house runs from the grid."
    : "";
  void raise({
    key: divergenceAlertKey(episodeOnsetMs),
    severity: "P2",
    title: "Inverter energy settings differ from the config",
    message:
      `${Math.round((nowMs - episodeOnsetMs) / 60_000)} min after a managed energy-distribution setting first ` +
      `differed from inverter_energy_distribution, ${state}; ${sendRounds} round(s) of setters sent. They are ` +
      `retried on a change of the machine model, working mode or these settings (up to ` +
      `${CHANGE_TRIGGERED_RETRIES_PER_EPISODE} times), else every ${ENFORCEMENT_FALLBACK_RETRY_MS / 60_000} min, ` +
      `and hold while a machine model switch is in flight or the readbacks are stale.${houseOnGridNote} Set it on ` +
      "the inverter's display, or mark the field unmanaged on the config page.",
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

function describeJudgedState(judged: EnforcementJudgement): string {
  const parts: string[] = [];
  if (judged.divergences.length) parts.push(`the inverter still reads ${describeDivergences(judged.divergences)}`);
  if (judged.unreadFields.length) {
    const unread = judged.unreadFields.map(field => ENERGY_DISTRIBUTION_FIELD_LABELS[field]).join(", ");
    parts.push(`its HECS answer lacks ${unread} (not checked, and never written on a guess)`);
  }
  return parts.join(", and ");
}

/**
 * One key per episode, by its onset: the manager's per-key cooldown (30 min, kept across restarts) must not
 * swallow the next episode's page
 */
function divergenceAlertKey(episodeOnsetMs: number): string {
  return `energy-distribution-divergence:${episodeOnsetMs}`;
}
