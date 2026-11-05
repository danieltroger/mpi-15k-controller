/**
 * What the energy-distribution enforcement decides, as pure functions of one snapshot (no I/O, no clock, no
 * Node built-ins: the System and config pages import the constants): the profile the DM readback puts in
 * force, whether a managed HECS field differs from it, and whether the setters go out now. Event-driven, no
 * settle delay: a readback that differs is written at once, and after a write that didn't land the next
 * attempt waits for something to change (the DM readback, the working mode, one of the enforced HECS fields,
 * the profile), at most CHANGE_TRIGGERED_RETRIES_PER_EPISODE times, or for the slow fallback when nothing
 * does. The readback that comes with a DM confirm can predate the reset: the next one showing it is just a
 * new difference.
 *
 * A setter is only ever queued once the session's identical-setter gate is open for it (the session's own
 * identicalSetterGateOpensAtMs, on its monotonic clock): one held there would still go out after the
 * enforcement had decided to hold (a DM switch pending, the field made unmanaged). One corner stays open: a
 * setter queued with its gate open that still waits behind a confirm run or a dead link when a hold begins
 * does go out. The session sends in queue order, so it reaches the wire before a DM151 queued after it: it is
 * never written into 151, only seconds stale. Only a session "withdraw by prefix" would close that. The same
 * corner, the other way: a setter still in the session's queue when the attempt key changes counts as
 * sendable, so the re-arm re-queues it (a same-command replacement, no extra write) and still spends one.
 * That errs towards fewer writes: a few of those can leave a follow-up waiting for the fallback.
 *
 * A managed field missing from the HECS answer is skipped, never written on a guess (a SEP write resets
 * EDB/EDC/EDG), while the fields that were read are judged and enforced. It doesn't open or hold a divergence
 * episode: energyDistributionUnreadFields.ts tracks and pages it on its own onset. The wiring is
 * useEnergyDistributionEnforcement.ts; the selftests drive these directly.
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
  /** Wall clock: the readbacks' times, the episode's onset, the fallback retry and the P2 */
  nowMs: number;
  /** The session's monotonic clock (performance.now()), which its identical-setter gate runs on */
  monotonicNowMs: number;
  machineModel: MachineModelReading | undefined;
  /** MOD's code; undefined = not read. Only a change of it matters (it re-arms an attempt) */
  workingModeCode: string | undefined;
  /** The grid-off switch's DM write hasn't shown in the readback yet: nothing is judged or written */
  machineModelSwitchPending: boolean;
  hecs: HecsReading | undefined;
  /** The oldest DM or HECS readback the enforcement acts on (gridOffDecisions.ts machineModelReadbackMaxAgeMs) */
  settingsReadbackMaxAgeMs: number;
  profiles: Pick<InverterEnergyDistributionConfig, "normal_hybrid" | "off_grid_iii">;
  /** The session's own: when its identical-setter gate lets a command out again (monotonic), undefined = open */
  identicalSetterGateOpensAtMs: (command: string) => number | undefined;
};

/** A managed field read differently from the profile, from the first readback that showed it until one shows none */
export type DivergenceEpisode = {
  onsetMs: number;
  sendRounds: number;
  lastSendAtMs: number | undefined;
  /** What the latest attempt was armed on (attemptKey): a change of it re-arms one */
  lastAttemptKey: string | undefined;
  /** Re-arms by a change whose round has gone out, so far (CHANGE_TRIGGERED_RETRIES_PER_EPISODE) */
  changeTriggeredRetries: number;
  /** Setters an attempt wanted that the session's gate would still have held: re-judged on every step */
  deferredCommands: readonly string[];
  /** The deferred setters are a change re-arm's whole round, not counted yet: the continuation spends it */
  deferredChangeRoundUncounted: boolean;
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
  /** The episode this step ended: every managed field that was read reads as the profile again */
  landed: DivergenceEpisode | undefined;
  /** This step started the episode */
  started: boolean;
  /** The profile in force and how HECS compares; undefined when no profile is in force or HECS is unusable */
  judged: EnforcementJudgement | undefined;
};

export type EnforcementJudgement = {
  profileName: EnergyDistributionProfileName;
  /** The managed fields read differently, in write order */
  divergences: EnergyDistributionFieldDivergence[];
  /** The managed fields the readback lacks: not judged, not written (energyDistributionUnreadFields.ts) */
  unreadFields: EnergyDistributionField[];
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
  const profile = situation.profiles[inForce.profileName];
  const judged: EnforcementJudgement = {
    profileName: inForce.profileName,
    divergences: energyDistributionDivergences(profile, hecs.fields),
    // A token missing from the answer says nothing about its field: the fields that were read are judged
    unreadFields: unreadManagedFields(profile, hecs.fields),
  };
  const { divergences } = judged;
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
    deferredChangeRoundUncounted: false,
    p2Raised: false,
    firstDivergences: divergences,
  };
  const raiseP2 = p2Due(openEpisode, nowMs, timing);
  const current = raiseP2 ? { ...openEpisode, p2Raised: true } : openEpisode;
  const outcome = { raiseP2, started, judged };

  const key = attemptKey(situation, divergences);
  const attempt = attemptKind(current, key, nowMs, timing);
  if (attempt === undefined) return judgedStep(outcome, current, undefined, waitingFor(current, situation, timing));
  // A re-arm or the fallback wants every current difference; a deferred continuation only what it deferred
  // and still differs (a field made unmanaged, matching or unread has dropped out)
  const wanted = divergences.filter(
    divergence => attempt !== "deferred" || current.deferredCommands.includes(setterForDivergence(divergence).command)
  );
  const sendable = wanted.filter(divergence => !gatedBySession(divergence, situation));
  const sendsNow = sendable.length > 0;
  const deferredCommands = wanted
    .filter(divergence => gatedBySession(divergence, situation))
    .map(divergence => setterForDivergence(divergence).command);
  // A change re-arm is spent by the round it sends: at once, or, while the gate still holds all it wants, by
  // the deferred continuation (left uncounted, a flapping working mode would write once a minute for good).
  // A change that only wants again what's already deferred sends nothing more, and spends nothing.
  const opensDeferredChangeRound =
    attempt === "change" && !sendsNow && deferredCommands.some(command => !current.deferredCommands.includes(command));
  const spendsRetry =
    sendsNow && (attempt === "change" || (attempt === "deferred" && current.deferredChangeRoundUncounted));
  const armed: DivergenceEpisode = {
    ...current,
    lastAttemptKey: attempt === "deferred" ? current.lastAttemptKey : key,
    changeTriggeredRetries: current.changeTriggeredRetries + (spendsRetry ? 1 : 0),
    deferredCommands,
    deferredChangeRoundUncounted:
      !sendsNow && deferredCommands.length > 0 && (opensDeferredChangeRound || current.deferredChangeRoundUncounted),
  };
  if (!sendable.length) return judgedStep(outcome, armed, undefined, waitingFor(armed, situation, timing));
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
  return gateHoldsForMs(setterForDivergence(divergence).command, situation) > 0;
}

/** How much longer the session's identical-setter gate holds this command; 0 = open */
function gateHoldsForMs(command: string, situation: EnforcementSituation): number {
  const opensAtMs = situation.identicalSetterGateOpensAtMs(command);
  return opensAtMs === undefined ? 0 : Math.max(0, opensAtMs - situation.monotonicNowMs);
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
  // An episode that never sent (its setters deferred, then dropped out) counts from its onset
  if (nowMs - (episode.lastSendAtMs ?? episode.onsetMs) >= timing.fallbackRetryMs) return "fallback";
  return undefined;
}

function waitingFor(episode: DivergenceEpisode, situation: EnforcementSituation, timing: EnforcementTiming): string {
  if (episode.deferredCommands.length) {
    const longestHoldMs = Math.max(...episode.deferredCommands.map(command => gateHoldsForMs(command, situation)));
    return `${episode.deferredCommands.join(", ")} went out less than ${IDENTICAL_SETTER_MIN_INTERVAL_MS / 1000} s ago: each is queued once the session's identical-setter gate lets it out (all within ${Math.ceil(longestHoldMs / 1000)} s)`;
  }
  const sinceSendMs = situation.nowMs - (episode.lastSendAtMs ?? episode.onsetMs);
  const fallbackInMinutes = Math.max(1, Math.ceil((timing.fallbackRetryMs - sinceSendMs) / 60_000));
  if (episode.changeTriggeredRetries >= CHANGE_TRIGGERED_RETRIES_PER_EPISODE) {
    return `not read back after ${CHANGE_TRIGGERED_RETRIES_PER_EPISODE} change-triggered retries: only the ${timing.fallbackRetryMs / 60_000}-min fallback retries now, next in ${fallbackInMinutes} min`;
  }
  const retried = `once the DM, the working mode, an enforced HECS field or the profile changes, or in ${fallbackInMinutes} min`;
  if (episode.lastSendAtMs === undefined) return `not written yet: tried ${retried}`;
  return `sent, not read back yet: retried ${retried}`;
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

function p2Due(episode: DivergenceEpisode | undefined, nowMs: number, timing: EnforcementTiming): boolean {
  return episode !== undefined && !episode.p2Raised && nowMs - episode.onsetMs >= timing.p2AfterMs;
}
