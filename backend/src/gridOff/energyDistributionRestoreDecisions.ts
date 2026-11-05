/**
 * What the energy-distribution restore decides, as pure functions (no I/O, no clock): which DM readbacks
 * start or cancel a restore episode, what an episode does next on a HECS readback or a tick, and whether
 * the page's restore button may run. The wiring is energyDistributionRestore.ts; the selftests drive these.
 *
 * Only a switch back to 050 starts an episode. Entering 151 resets HECS too (2026-11-05: feed off, AC
 * charge on), but in Off-Grid III the relay is open and the inverter runs its own off-grid logic, and the
 * return to 050 resets HECS again anyway: writing in 151 would only add settings writes and NAK risk.
 */
import type { NormalEnergyDistribution } from "../config/config.types.ts";
import type { DecodedFields } from "../inverterComms/pi17Protocol.types.ts";
import { describeMachineModel, NORMAL_HYBRID_MODEL } from "../inverterComms/machineModel.ts";
import { SETTINGS_READBACK_REQUEST_LIFETIME_MS } from "../inverterComms/schedulerTiming.ts";
import type { EnergyDistributionFieldMismatch, EnergyDistributionRestoreProgress } from "./gridOff.types.ts";
import { energyDistributionMismatches } from "./energyDistributionProfile.ts";

/**
 * While the readback still differs, the setters go out again 1, 2 and 5 min after the previous round, then
 * every 10 min: each is a settings write (EEPROM), and a firmware that keeps refusing one would otherwise
 * take one a minute for as long as it lasts. A guard constant, as for the DM050 resends.
 */
export const RESTORE_RESEND_INTERVALS_MS: readonly number[] = [60_000, 120_000, 300_000, 600_000];

/** A HECS readback asked for and not yet decoded is asked for again after this (the request's own lifetime) */
export const RESTORE_READBACK_REQUEST_REPEAT_MS = SETTINGS_READBACK_REQUEST_LIFETIME_MS;

export type RestoreTiming = {
  resendIntervalsMs: readonly number[];
  readbackRequestRepeatMs: number;
  /** From grid_off.settings_restore_p2_after_minutes; harnesses may scale it down */
  p2AfterMs: number;
};

export type RestoreEpisode = {
  trigger: EnergyDistributionRestoreProgress["trigger"];
  /** Wall-clock ms of the DM readback that showed 050, or of the button press */
  onsetMs: number;
  /**
   * HECS readbacks decoded before this aren't judged: the confirm reads HECS before DM, so the one beside
   * the 050 readback can predate the reset, and then the satisfied drop would withdraw the restore unsent
   */
  judgeReadbacksFromMs: number;
  sendRounds: number;
  lastSendAtMs: number | undefined;
  readbackRequestedAtMs: number | undefined;
  p2Raised: boolean;
  /** What differed at the first judged readback, for the one-line log once it's restored */
  firstMismatches: EnergyDistributionFieldMismatch[] | undefined;
};

export type HecsReadback = { fields: DecodedFields; decodedAtMs: number };

export type RestoreStep =
  | { action: "wait"; reason: string }
  /** No HECS readback after judgeReadbacksFromMs yet: ask the session for one */
  | { action: "request_readback" }
  /** Queue these fields' setters, in this (restore) order */
  | { action: "send"; mismatches: EnergyDistributionFieldMismatch[] }
  /** The readback matches the profile: the episode is over */
  | { action: "done"; firstMismatches: EnergyDistributionFieldMismatch[] };

export function startRestoreEpisode(
  trigger: RestoreEpisode["trigger"],
  onsetMs: number,
  settleMs: number
): RestoreEpisode {
  return {
    trigger,
    onsetMs,
    judgeReadbacksFromMs: onsetMs + settleMs,
    sendRounds: 0,
    lastSendAtMs: undefined,
    readbackRequestedAtMs: undefined,
    p2Raised: false,
    firstMismatches: undefined,
  };
}

/**
 * A DM readback against the previous one: "start" an episode on a change to 050, "cancel" one on a change
 * away from it. The first readback since the start is never a change: a controller start writes nothing on
 * its own (a 151 found then is switched back, and that 151 → 050 is a change).
 */
export function restoreTriggerOnReadback(
  previousModel: string | undefined,
  model: string
): { action: "none" } | { action: "start" | "cancel"; reason: string } {
  if (previousModel === undefined || previousModel === model) return { action: "none" };
  const change = `${describeMachineModel(previousModel)} → ${describeMachineModel(model)}`;
  return model === NORMAL_HYBRID_MODEL
    ? { action: "start", reason: `the DM readback changed ${change}` }
    : { action: "cancel", reason: `the DM readback changed ${change}` };
}

/** The episode's next step on the latest HECS readback, the episode after it, and whether the P2 is due */
export function nextRestoreStep(
  episode: RestoreEpisode,
  { nowMs, hecs, profile }: { nowMs: number; hecs: HecsReadback | undefined; profile: NormalEnergyDistribution },
  timing: RestoreTiming
): { step: RestoreStep; episode: RestoreEpisode; raiseP2: boolean } {
  if (nowMs < episode.judgeReadbacksFromMs) {
    const waitSeconds = Math.ceil((episode.judgeReadbacksFromMs - nowMs) / 1000);
    return { step: { action: "wait", reason: `settling, ${waitSeconds} s to go` }, episode, raiseP2: false };
  }
  const fresh = hecs !== undefined && hecs.decodedAtMs >= episode.judgeReadbacksFromMs;
  const mismatches = fresh ? energyDistributionMismatches(profile, hecs.fields) : undefined;
  if (mismatches?.length === 0) {
    return { step: { action: "done", firstMismatches: episode.firstMismatches ?? [] }, episode, raiseP2: false };
  }
  // Counted from the end of the settling, and due without a fresh readback too: a HECS that never answers
  // leaves the settings just as unrestored
  const raiseP2 = !episode.p2Raised && nowMs - episode.judgeReadbacksFromMs >= timing.p2AfterMs;
  const withP2 = raiseP2 ? { ...episode, p2Raised: true } : episode;
  if (!mismatches) {
    const requestDue =
      episode.readbackRequestedAtMs === undefined ||
      nowMs - episode.readbackRequestedAtMs >= timing.readbackRequestRepeatMs;
    return requestDue
      ? { step: { action: "request_readback" }, episode: { ...withP2, readbackRequestedAtMs: nowMs }, raiseP2 }
      : { step: { action: "wait", reason: "waiting for a fresh HECS readback" }, episode: withP2, raiseP2 };
  }
  if (!resendDue(episode, nowMs, timing.resendIntervalsMs)) {
    return { step: { action: "wait", reason: "resend back-off" }, episode: withP2, raiseP2 };
  }
  return {
    step: { action: "send", mismatches },
    episode: {
      ...withP2,
      sendRounds: episode.sendRounds + 1,
      lastSendAtMs: nowMs,
      firstMismatches: episode.firstMismatches ?? mismatches,
    },
    raiseP2,
  };
}

function resendDue(episode: RestoreEpisode, nowMs: number, resendIntervalsMs: readonly number[]): boolean {
  if (episode.sendRounds === 0 || episode.lastSendAtMs === undefined) return true;
  const intervalIndex = Math.min(episode.sendRounds - 1, resendIntervalsMs.length - 1);
  return nowMs - episode.lastSendAtMs >= resendIntervalsMs[intervalIndex]!;
}

export type ManualRestoreSituation = {
  gridOffInForce: boolean;
  /** The DM readback, verbatim; undefined = not read yet */
  readbackModel: string | undefined;
  /** Why the GS/PS readings are too old to act on (gridOffDecisions.ts), or undefined */
  readingsStaleness: string | undefined;
  /** A buy, sell or hold window running now (gridOffDecisions.ts), or undefined */
  activeWindow: string | undefined;
};

/** Why the page's "Restore normal settings" must be refused, or undefined when it may run */
export function manualRestoreRefusal(situation: ManualRestoreSituation): string | undefined {
  if (situation.gridOffInForce) {
    return "grid-off is in force: the settings are restored by themselves once the inverter reads 050 again";
  }
  if (situation.readbackModel !== undefined && situation.readbackModel !== NORMAL_HYBRID_MODEL) {
    return `the inverter reads ${describeMachineModel(situation.readbackModel)}; the settings are only restored in normal hybrid (050)`;
  }
  if (situation.readingsStaleness) return situation.readingsStaleness;
  if (situation.activeWindow) return `${situation.activeWindow}: restore once it has ended`;
  return undefined;
}
