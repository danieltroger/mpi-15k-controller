/**
 * The P2 for a managed energy-distribution field that still differs from its config profile
 * inverter_energy_distribution.p2_after_minutes after it was first seen, and a P3 once it reads back as the
 * profile; the same pair, on its own key and onset, for a managed field missing from the inverter's HECS
 * answers (with its log lines). The decisions are energyDistributionEnforcementDecisions.ts's
 * nextEnforcementStep and energyDistributionUnreadFields.ts; this file only words and raises them. Episodes
 * aren't kept across a restart: one open then gets no P3 (and, still differing, starts a new episode with its
 * own P2).
 */
import type { AlertManager } from "../alerting/alertManager.ts";
import { errorLog, logLog, warnLog } from "../utilities/logging.ts";
import type { EnergyDistributionField, EnergyDistributionFieldDivergence } from "./energyDistribution.types.ts";
import { describeDivergences, describeUnreadFields } from "./energyDistributionProfile.ts";
import {
  CHANGE_TRIGGERED_RETRIES_PER_EPISODE,
  ENFORCEMENT_FALLBACK_RETRY_MS,
} from "./energyDistributionEnforcementDecisions.ts";
import type { UnreadFieldsStep } from "./energyDistributionUnreadFields.ts";

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
  const houseOnGridNote = divergences?.some(
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
  {
    episodeOnsetMs,
    nowMs,
    unreadFields,
  }: {
    episodeOnsetMs: number;
    nowMs: number;
    /** Missing from the readback that ended it: those have their own alert */
    unreadFields: readonly EnergyDistributionField[];
  }
): void {
  const minutes = Math.round((nowMs - episodeOnsetMs) / 60_000);
  void raise({
    key: `${divergenceAlertKey(episodeOnsetMs)}:resolved`,
    severity: "P3",
    title: "Resolved: Inverter energy settings differ from the config",
    message: unreadFields.length
      ? `Every managed energy-distribution setting the inverter reports reads as the config again, ${minutes} min after the difference was first seen. Its answer lacks ${describeUnreadFields(unreadFields)}: that has its own alert.`
      : `Every managed energy-distribution setting reads as the config again, ${minutes} min after the difference was first seen.`,
  }).catch(error => errorLog("Energy distribution: raising the divergence resolve notice failed", error));
}

/** The log lines, the P2 and the P3 of a managed field missing from the HECS answers (nextUnreadFieldsStep) */
export function reportUnreadFieldsStep(raise: AlertManager["raise"], step: UnreadFieldsStep, nowMs: number): void {
  const { episode, resolved } = step;
  if (step.started && episode) {
    warnLog(
      `Energy distribution: the inverter's HECS answer lacks ${describeUnreadFields(episode.fields)} — not checked, nothing written to it until it's read (a P2 if that takes p2_after_minutes)`
    );
  }
  if (step.raiseP2 && episode) {
    const minutes = Math.round((nowMs - episode.sinceMs) / 60_000);
    warnLog(
      `Energy distribution: ${describeUnreadFields(episode.fields)} still missing from the HECS answer ${minutes} min after it first was; paging P2`
    );
    void raise({
      key: unreadAlertKey(episode.sinceMs),
      severity: "P2",
      title: "Inverter energy settings missing from its answer",
      message:
        `For ${minutes} min the inverter's HECS answer has lacked ${describeUnreadFields(episode.fields)}, which ` +
        "inverter_energy_distribution manages: nothing is checked or written there (never on a guess), the other " +
        "settings are still enforced. Check the inverter's firmware or the HECS decoding, or mark the field " +
        "unmanaged on the config page.",
    }).catch(error => errorLog("Energy distribution: raising the missing-field P2 failed", error));
  }
  if (!resolved) return;
  const minutes = Math.round((nowMs - resolved.sinceMs) / 60_000);
  logLog(`Energy distribution: the HECS answer has every managed field again (${minutes} min after one was missing)`);
  if (!resolved.p2Raised) return;
  void raise({
    key: `${unreadAlertKey(resolved.sinceMs)}:resolved`,
    severity: "P3",
    title: "Resolved: Inverter energy settings missing from its answer",
    message: `The inverter's HECS answer has every managed energy-distribution setting again, ${minutes} min after one was first missing.`,
  }).catch(error => errorLog("Energy distribution: raising the missing-field resolve notice failed", error));
}

/**
 * One key per episode, by its onset: the manager's per-key cooldown (30 min, kept across restarts) must not
 * swallow the next episode's page
 */
function divergenceAlertKey(episodeOnsetMs: number): string {
  return `energy-distribution-divergence:${episodeOnsetMs}`;
}

/** As divergenceAlertKey, for the missing-field episodes: neither swallows the other's page */
function unreadAlertKey(sinceMs: number): string {
  return `energy-distribution-unread:${sinceMs}`;
}
