/**
 * What the energy-distribution enforcement decides, as pure functions of one snapshot (no I/O, no clock):
 * the profile the DM readback puts in force, whether a managed HECS field differs from it, and whether the
 * setters go out now. Event-driven, no settle delay: a readback that differs is written at once, and after
 * a write that didn't land the next attempt waits for something to change (the DM readback, the working
 * mode, one of the enforced HECS fields, the profile), at most CHANGE_TRIGGERED_RETRIES_PER_EPISODE times,
 * or for the slow fallback when nothing does. The readback that comes with a DM confirm can predate the
 * reset: the next one showing it is just a new difference. A setter is only ever queued when the session's
 * identical-setter gate won't hold it: one held there would still go out after the enforcement had decided
 * to hold (a DM switch pending, the field made unmanaged). The wiring is useEnergyDistributionEnforcement.ts;
 * the selftests drive these directly.
 */
import type { InverterEnergyDistributionConfig } from "../config/config.types.ts";
import type { DecodedFields } from "../inverterComms/pi17Protocol.types.ts";
import { describeMachineModel, isWhitelistedMachineModel } from "../inverterComms/machineModel.ts";
import { IDENTICAL_SETTER_MIN_INTERVAL_MS } from "../inverterComms/schedulerTiming.ts";
import type {
  EnergyDistributionField,
  EnergyDistributionFieldDivergence,
  EnergyDistributionProfileName,
} from "./energyDistribution.types.ts";
import {
  ENERGY_DISTRIBUTION_FIELD_LABELS,
  energyDistributionDivergences,
  PROFILE_BY_MACHINE_MODEL,
  setterForDivergence,
  unreadManagedFields,
} from "./energyDistributionProfile.ts";

/**
 * With nothing changed since the last attempt (a firmware that keeps refusing a write, a commit that never
 * comes), or once the change-triggered retries are used up, the setters go out again only this often: each
 * is a settings write (EEPROM), and retrying on every readback is what made feeding's EDF1 a NAK a minute.
 * A guard constant, as for the DM050 resends.
 */
export const ENFORCEMENT_FALLBACK_RETRY_MS = 10 * 60_000;

/**
 * How many times per episode a change (DM, working mode, an enforced HECS field, the profile) re-arms a
 * write. The convergences seen on 2026-11-05 need two: the DM reset's round, then EDC1 after SEP's own
 * reset; a partial landing or a working mode change mid-way takes one more. A firmware that applies SEP's
 * side effects but not the priority would otherwise re-arm on every one of them (about a minute each). A
 * guard constant (EEPROM wear); past it only the fallback retries.
 */
export const CHANGE_TRIGGERED_RETRIES_PER_EPISODE = 3;

/**
 * A setter is queued only this long after the last time it was queued: the session holds an identical one
 * for IDENTICAL_SETTER_MIN_INTERVAL_MS from its send, and the send follows the queueing by the queue's own
 * wait (a confirm run or a poll round, seconds). The margin keeps the gate open by the time it's queued.
 */
export const IDENTICAL_SETTER_REQUEUE_AFTER_MS = IDENTICAL_SETTER_MIN_INTERVAL_MS + 15_000;

/**
 * Buying (EDB) and feeding (EDF/EDG) move these themselves, SEP's reset moves them too: none of that can make
 * a refused write of ours land, so none of it re-arms one
 */
const FIELDS_OTHERS_OWN: ReadonlySet<string> = new Set([
  "ac_charge_battery",
  "battery_discharge_to_feed_grid_when_solar_input_normal",
  "battery_discharge_to_feed_grid_when_solar_input_loss",
]);

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
  /** When each setter was last queued (wall-clock ms), across episodes: what the session's gate still holds */
  lastQueuedAtByCommand: Readonly<Record<string, number>>;
};

/** A managed field differing from the profile, from the first readback that showed it until one shows none */
export type DivergenceEpisode = {
  onsetMs: number;
  sendRounds: number;
  lastSendAtMs: number | undefined;
  /** What the latest attempt was armed on (attemptKey): a change of it re-arms one */
  lastAttemptKey: string | undefined;
  /** Re-arms by a change so far (CHANGE_TRIGGERED_RETRIES_PER_EPISODE) */
  changeTriggeredRetries: number;
  /** Setters an attempt wanted that the session's gate would still have held: re-judged on every step */
  deferredCommands: readonly string[];
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
  const unusable = unusableReason(situation, inForce);
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
    changeTriggeredRetries: 0,
    deferredCommands: [],
    p2Raised: false,
    firstDivergences: divergences,
  };
  const raiseP2 = p2Due(openEpisode, nowMs, timing);
  const current = raiseP2 ? { ...openEpisode, p2Raised: true } : openEpisode;
  const outcome = { raiseP2, started, judged };

  const key = attemptKey(situation, divergences);
  const attempt = attemptKind(current, key, nowMs, timing);
  if (attempt === undefined) return judgedStep(outcome, current, undefined, waitingFor(current, nowMs, timing));
  // A re-arm or the fallback wants every current difference; a deferred continuation only what it deferred
  // and still differs (a field made unmanaged, or matching, has dropped out)
  const wanted = divergences.filter(
    divergence => attempt !== "deferred" || current.deferredCommands.includes(setterForDivergence(divergence).command)
  );
  const sendable = wanted.filter(divergence => !gatedBySession(divergence, situation));
  const armed: DivergenceEpisode = {
    ...current,
    lastAttemptKey: attempt === "deferred" ? current.lastAttemptKey : key,
    changeTriggeredRetries: current.changeTriggeredRetries + (attempt === "change" ? 1 : 0),
    deferredCommands: wanted
      .filter(divergence => gatedBySession(divergence, situation))
      .map(divergence => setterForDivergence(divergence).command),
  };
  if (!sendable.length) return judgedStep(outcome, armed, undefined, waitingFor(armed, nowMs, timing));
  return judgedStep(outcome, { ...armed, sendRounds: armed.sendRounds + 1, lastSendAtMs: nowMs }, sendable, undefined);
}

function judgedStep(
  outcome: Pick<EnforcementStep, "raiseP2" | "started" | "judged">,
  episode: DivergenceEpisode,
  send: EnforcementStep["send"],
  waitingReason: string | undefined
): EnforcementStep {
  return { ...outcome, episode, send, waitingReason, landed: undefined };
}

/** Would the session's identical-setter gate still hold this setter if it were queued now? */
function gatedBySession(divergence: EnergyDistributionFieldDivergence, situation: EnforcementSituation): boolean {
  const lastQueuedAtMs = situation.lastQueuedAtByCommand[setterForDivergence(divergence).command];
  return lastQueuedAtMs !== undefined && situation.nowMs - lastQueuedAtMs < IDENTICAL_SETTER_REQUEUE_AFTER_MS;
}

/** Why this snapshot can't be judged, or undefined when it can */
function unusableReason(
  situation: EnforcementSituation,
  inForce: ReturnType<typeof profileInForce>
): string | undefined {
  const { nowMs, hecs } = situation;
  if (situation.machineModelSwitchPending) {
    return "a machine model switch is pending (the DM readback doesn't show it yet)";
  }
  if ("noProfileReason" in inForce) return inForce.noProfileReason;
  if (!hecs) return "HECS hasn't been read";
  if (nowMs - hecs.decodedAtMs > situation.settingsReadbackMaxAgeMs) {
    return `the HECS readback is ${Math.round((nowMs - hecs.decodedAtMs) / 60_000)} min old`;
  }
  // A token missing from the answer says nothing about the field, and a SEP write on a guess resets EDB/EDC/EDG
  const unread = unreadManagedFields(situation.profiles[inForce.profileName], hecs.fields);
  if (unread.length) return `the HECS readback lacks ${unread.map(describeField).join(", ")}`;
  return undefined;
}

/** What makes this step an attempt, or undefined when none is due */
function attemptKind(
  episode: DivergenceEpisode,
  key: string,
  nowMs: number,
  timing: EnforcementTiming
): "first" | "change" | "deferred" | "fallback" | undefined {
  if (episode.lastAttemptKey === undefined) return "first";
  if (key !== episode.lastAttemptKey && episode.changeTriggeredRetries < CHANGE_TRIGGERED_RETRIES_PER_EPISODE) {
    return "change";
  }
  if (episode.deferredCommands.length) return "deferred";
  if (episode.lastSendAtMs !== undefined && nowMs - episode.lastSendAtMs >= timing.fallbackRetryMs) return "fallback";
  return undefined;
}

function waitingFor(episode: DivergenceEpisode, nowMs: number, timing: EnforcementTiming): string {
  if (episode.deferredCommands.length) {
    return `${episode.deferredCommands.join(", ")} went out less than ${IDENTICAL_SETTER_REQUEUE_AFTER_MS / 1000} s ago: re-judged once the session's identical-setter gate is open`;
  }
  const sinceSendMs = nowMs - (episode.lastSendAtMs ?? nowMs);
  const fallbackInMinutes = Math.max(1, Math.ceil((timing.fallbackRetryMs - sinceSendMs) / 60_000));
  if (episode.changeTriggeredRetries >= CHANGE_TRIGGERED_RETRIES_PER_EPISODE) {
    return `not read back after ${CHANGE_TRIGGERED_RETRIES_PER_EPISODE} change-triggered retries: only the ${timing.fallbackRetryMs / 60_000}-min fallback retries now, next in ${fallbackInMinutes} min`;
  }
  return `sent, not read back yet: retried once the DM, the working mode, an enforced HECS field or the profile changes, or in ${fallbackInMinutes} min`;
}

/**
 * Everything an attempt is armed on: the DM readback, the working mode, the HECS fields nobody else moves,
 * and the setters the profile asks for. Anything else changing can't make a refused write land.
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
      .filter(field => !FIELDS_OTHERS_OWN.has(field))
      .sort()
      .map(field => [field, hecsFields[field]]),
    setters: divergences.map(divergence => setterForDivergence(divergence).command),
  });
}

function describeField(field: EnergyDistributionField): string {
  return ENERGY_DISTRIBUTION_FIELD_LABELS[field];
}

function p2Due(episode: DivergenceEpisode | undefined, nowMs: number, timing: EnforcementTiming): boolean {
  return episode !== undefined && !episode.p2Raised && nowMs - episode.onsetMs >= timing.p2AfterMs;
}
