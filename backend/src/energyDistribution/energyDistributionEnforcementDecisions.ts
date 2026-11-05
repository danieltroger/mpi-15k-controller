/**
 * What the energy-distribution enforcement decides, as pure functions of one snapshot (no I/O, no clock):
 * the profile the DM readback puts in force, whether a managed HECS field differs from it, and whether the
 * setters go out now. Event-driven, no settle delay: a readback that differs is written at once, and after
 * a write that didn't land the next attempt waits for something to change (the DM readback, the working
 * mode, any HECS field, the profile), or for a slow fallback when nothing does. The readback that comes with
 * a DM confirm can predate the reset: the next one showing it is just a new difference. The wiring is
 * useEnergyDistributionEnforcement.ts; the selftests drive these directly.
 */
import type { InverterEnergyDistributionConfig } from "../config/config.types.ts";
import type { DecodedFields } from "../inverterComms/pi17Protocol.types.ts";
import { describeMachineModel, isWhitelistedMachineModel } from "../inverterComms/machineModel.ts";
import type { EnergyDistributionFieldDivergence, EnergyDistributionProfileName } from "./energyDistribution.types.ts";
import {
  energyDistributionDivergences,
  PROFILE_BY_MACHINE_MODEL,
  setterForDivergence,
} from "./energyDistributionProfile.ts";

/**
 * With nothing changed since the last attempt (a firmware that keeps refusing a write, a commit that never
 * comes) the same setters go out again only this often: each is a settings write (EEPROM), and retrying on
 * every readback is what made feeding's EDF1 a NAK a minute. A guard constant, as for the DM050 resends.
 */
export const ENFORCEMENT_FALLBACK_RETRY_MS = 10 * 60_000;

export type EnforcementTiming = {
  /** From inverter_energy_distribution.p2_after_minutes */
  p2AfterMs: number;
  /** ENFORCEMENT_FALLBACK_RETRY_MS; harnesses scale it down */
  fallbackRetryMs: number;
};

/** The DM readback (wall-clock ms) */
export type MachineModelReading = { model: string; atMs: number };
export type HecsReading = { fields: DecodedFields; decodedAtMs: number };

export type EnforcementSituation = {
  nowMs: number;
  machineModel: MachineModelReading | undefined;
  /** MOD's code; undefined = not read. Only a change of it matters (it re-arms an attempt) */
  workingModeCode: string | undefined;
  /** The grid-off switch's DM write hasn't shown in the readback yet: nothing is judged or written */
  machineModelSwitchPending: boolean;
  hecs: HecsReading | undefined;
  /** The oldest DM or HECS readback the enforcement acts on (gridOffDecisions.ts machineModelReadbackMaxAgeMs) */
  settingsReadbackMaxAgeMs: number;
  profiles: Pick<InverterEnergyDistributionConfig, "normal_hybrid" | "off_grid_iii">;
};

/** A managed field differing from the profile, from the first readback that showed it until one shows none */
export type DivergenceEpisode = {
  onsetMs: number;
  sendRounds: number;
  lastSendAtMs: number | undefined;
  /** What the latest round was sent on (attemptKey): the next one goes out once that changes */
  lastAttemptKey: string | undefined;
  p2Raised: boolean;
  /** What differed when it was first seen, for the one-line log once it lands */
  firstDivergences: readonly EnergyDistributionFieldDivergence[];
};

export type EnforcementStep = {
  episode: DivergenceEpisode | undefined;
  /** Queue these fields' setters, in this (write) order; undefined = nothing to send now */
  send: readonly EnergyDistributionFieldDivergence[] | undefined;
  /** Why nothing goes out although a field differs; undefined while sending or while nothing differs */
  waitingReason: string | undefined;
  /** The episode's P2 is due (once per episode) */
  raiseP2: boolean;
  /** The episode this step ended: every managed field reads as the profile again */
  landed: DivergenceEpisode | undefined;
  /** This step started the episode */
  started: boolean;
  /** The profile in force and what differs from it; undefined when no profile is in force or HECS is unusable */
  judged: { profileName: EnergyDistributionProfileName; divergences: EnergyDistributionFieldDivergence[] } | undefined;
};

/** The profile the DM readback puts in force, or why none is */
export function profileInForce(
  situation: Pick<EnforcementSituation, "nowMs" | "machineModel" | "settingsReadbackMaxAgeMs">
): { profileName: EnergyDistributionProfileName } | { noProfileReason: string } {
  const { machineModel, nowMs } = situation;
  if (!machineModel) return { noProfileReason: "the machine model (DM) hasn't been read" };
  const ageMs = nowMs - machineModel.atMs;
  if (ageMs > situation.settingsReadbackMaxAgeMs) {
    return { noProfileReason: `the DM readback is ${Math.round(ageMs / 60_000)} min old` };
  }
  if (!isWhitelistedMachineModel(machineModel.model)) {
    return {
      noProfileReason: `the inverter reports ${describeMachineModel(machineModel.model)}, which has no profile`,
    };
  }
  return { profileName: PROFILE_BY_MACHINE_MODEL[machineModel.model] };
}

export function nextEnforcementStep(
  episode: DivergenceEpisode | undefined,
  situation: EnforcementSituation,
  timing: EnforcementTiming
): EnforcementStep {
  const { nowMs, hecs } = situation;
  const inForce = profileInForce(situation);
  const unusable = situation.machineModelSwitchPending
    ? "a machine model switch is pending (the DM readback doesn't show it yet)"
    : "noProfileReason" in inForce
      ? inForce.noProfileReason
      : !hecs
        ? "HECS hasn't been read"
        : nowMs - hecs.decodedAtMs > situation.settingsReadbackMaxAgeMs
          ? `the HECS readback is ${Math.round((nowMs - hecs.decodedAtMs) / 60_000)} min old`
          : undefined;
  if (unusable !== undefined || "noProfileReason" in inForce || !hecs) {
    // Not judged: an open episode stays open (and still pages once it's overdue), nothing is written
    const raiseP2 = p2Due(episode, nowMs, timing);
    return {
      episode: raiseP2 && episode ? { ...episode, p2Raised: true } : episode,
      send: undefined,
      waitingReason: episode ? unusable : undefined,
      raiseP2,
      landed: undefined,
      started: false,
      judged: undefined,
    };
  }
  const divergences = energyDistributionDivergences(situation.profiles[inForce.profileName], hecs.fields);
  const judged = { profileName: inForce.profileName, divergences };
  if (!divergences.length) {
    return {
      episode: undefined,
      send: undefined,
      waitingReason: undefined,
      raiseP2: false,
      landed: episode,
      started: false,
      judged,
    };
  }
  const started = episode === undefined;
  const openEpisode: DivergenceEpisode = episode ?? {
    onsetMs: nowMs,
    sendRounds: 0,
    lastSendAtMs: undefined,
    lastAttemptKey: undefined,
    p2Raised: false,
    firstDivergences: divergences,
  };
  const raiseP2 = p2Due(openEpisode, nowMs, timing);
  const current = raiseP2 ? { ...openEpisode, p2Raised: true } : openEpisode;
  const key = attemptKey(situation, divergences);
  const fallbackDue = current.lastSendAtMs !== undefined && nowMs - current.lastSendAtMs >= timing.fallbackRetryMs;
  if (current.sendRounds > 0 && key === current.lastAttemptKey && !fallbackDue) {
    const retryInMinutes = Math.ceil((timing.fallbackRetryMs - (nowMs - (current.lastSendAtMs ?? nowMs))) / 60_000);
    return {
      episode: current,
      send: undefined,
      waitingReason: `sent, not read back yet: retried once the DM, the working mode, HECS or the profile changes, or in ${retryInMinutes} min`,
      raiseP2,
      landed: undefined,
      started,
      judged,
    };
  }
  return {
    episode: { ...current, sendRounds: current.sendRounds + 1, lastSendAtMs: nowMs, lastAttemptKey: key },
    send: divergences,
    waitingReason: undefined,
    raiseP2,
    landed: undefined,
    started,
    judged,
  };
}

/**
 * Everything an attempt was made on: the DM readback, the working mode, every HECS field and the setters
 * the profile asks for. Anything else changing can't make a refused write land.
 */
function attemptKey(
  situation: EnforcementSituation,
  divergences: readonly EnergyDistributionFieldDivergence[]
): string {
  const hecsFields = situation.hecs?.fields ?? {};
  return JSON.stringify({
    machine_model: situation.machineModel?.model,
    working_mode: situation.workingModeCode,
    hecs: Object.keys(hecsFields)
      .sort()
      .map(field => [field, hecsFields[field]]),
    setters: divergences.map(divergence => setterForDivergence(divergence).command),
  });
}

function p2Due(episode: DivergenceEpisode | undefined, nowMs: number, timing: EnforcementTiming): boolean {
  return episode !== undefined && !episode.p2Raised && nowMs - episode.onsetMs >= timing.p2AfterMs;
}
