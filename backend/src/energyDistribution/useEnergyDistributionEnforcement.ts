/**
 * The inverter's HECS energy-distribution settings, enforced from config the way feeding enforces its feed
 * targets: config inverter_energy_distribution holds a profile per machine model, the DM readback picks the
 * one in force, and every managed field the HECS readback shows differently is written at once (SEP, then
 * EDD/EDE, then EDA/EDC). A DM change resets HECS to the factory defaults (2026-11-05), a value changed on the
 * inverter's display, a config edit: all are just a difference. A write that doesn't land is retried when
 * something changes (the DM readback, the working mode, an enforced HECS field, the profile; a few times per
 * episode) and otherwise every ENFORCEMENT_FALLBACK_RETRY_MS, with one P2 per divergence episode after
 * p2_after_minutes. Nothing is written while the DM readback is unknown or stale, while a DM switch is in
 * flight, nor queued where the session's identical-setter gate would hold it (the session's own gate time,
 * on its monotonic clock); a managed field the HECS answer lacks is never written, and keeps the episode
 * open. AC charge (EDB) and battery feed to the grid (EDF/EDG) stay with buying and feeding. Decisions, and
 * the one corner the gate check leaves open: energyDistributionEnforcementDecisions.ts.
 */
import { type Accessor, createEffect, createMemo, createSignal, onCleanup, type Setter, untrack } from "solid-js";
import type { Config, InverterEnergyDistributionConfig } from "../config/config.types.ts";
import type { DecodedRound, MachineModelCode, SettingsQueryCommandName } from "../inverterComms/pi17Protocol.types.ts";
import type { SetterQueueItem, SetterResult } from "../inverterComms/inverterComms.types.ts";
import type { AlertManager } from "../alerting/alertManager.ts";
import { useInverterComms } from "../inverterComms/InverterCommsProvider.ts";
import { SETTINGS_READBACK_REQUEST_LIFETIME_MS } from "../inverterComms/schedulerTiming.ts";
import { machineModelReadbackMaxAgeMs } from "../gridOff/gridOffDecisions.ts";
import { isWhitelistedMachineModel } from "../inverterComms/machineModel.ts";
import { errorLog, logLog, warnLog } from "../utilities/logging.ts";
import type {
  EnergyDistributionFieldDivergence,
  EnergyDistributionProfileName,
  EnergyDistributionStatus,
} from "./energyDistribution.types.ts";
import {
  describeDivergences,
  ENERGY_DISTRIBUTION_FIELD_LABELS,
  ENERGY_DISTRIBUTION_FIELDS,
  PROFILE_BY_MACHINE_MODEL,
  setterForDivergence,
} from "./energyDistributionProfile.ts";
import { effectiveEnergyDistributionSettings } from "./energyDistributionSettings.ts";
import {
  type DivergenceEpisode,
  CHANGE_TRIGGERED_RETRIES_PER_EPISODE,
  ENFORCEMENT_FALLBACK_RETRY_MS,
  type EnforcementJudgement,
  type EnforcementSituation,
  type EnforcementStep,
  type EnforcementTiming,
  type HecsReading,
  type MachineModelReading,
  nextEnforcementStep,
} from "./energyDistributionEnforcementDecisions.ts";
import { raiseDivergenceLandedAfterP2, raiseDivergenceNotLanded } from "./energyDistributionAlert.ts";

/** How often the time-based parts (the fallback retry, the P2, readback staleness) are re-judged */
const ENFORCEMENT_TICK_INTERVAL_MS = 10_000;

export function useEnergyDistributionEnforcement({
  config,
  raise,
  requestedMachineModel,
}: {
  config: Accessor<Config>;
  raise: AlertManager["raise"];
  /** The grid-off switch's request: while the DM readback doesn't show it, a DM write is in flight */
  requestedMachineModel: Accessor<MachineModelCode>;
}) {
  const { queueSetter, identicalSetterGateOpensAtMs, requestSettingsReadback, lastDecodedRound, inverterStatus } =
    useInverterComms();
  return createEnergyDistributionEnforcement({
    config,
    queueSetter,
    identicalSetterGateOpensAtMs,
    requestSettingsReadback,
    lastDecodedRound,
    workingModeCode: () => inverterStatus().working_mode?.code,
    requestedMachineModel,
    raise,
    wallClockNowMs: () => Date.now(),
    monotonicNowMs: () => performance.now(),
    timingOverrides: undefined,
  });
}

/** Everything the enforcement reads and writes, as plain accessors so a selftest can build the graph */
export type EnergyDistributionEnvironment = {
  config: Accessor<Config>;
  queueSetter: (item: SetterQueueItem) => void;
  /** The session's: when its identical-setter gate lets a command out again (monotonicNowMs's clock) */
  identicalSetterGateOpensAtMs: (command: string) => number | undefined;
  /** The session's early settings readback: asked for (at most once a minute) when the DM or the working mode changes */
  requestSettingsReadback: (query: SettingsQueryCommandName) => void;
  /** DM and HECS rounds give the readbacks the enforcement judges */
  lastDecodedRound: Accessor<DecodedRound | undefined>;
  /** MOD's code; undefined = not read */
  workingModeCode: Accessor<string | undefined>;
  /**
   * The machine model the grid-off switch asks for. While the DM readback shows another one a switch is in
   * flight: the confirm reads HECS before DM, so a HECS showing the switch's reset can arrive while the DM
   * readback still names the old model, and writing then would apply the old model's profile to the new one
   */
  requestedMachineModel: Accessor<MachineModelCode>;
  raise: AlertManager["raise"];
  /** Date.now() in production */
  wallClockNowMs: () => number;
  /** performance.now() in production: the clock the session's identical-setter gate runs on */
  monotonicNowMs: () => number;
  /** Harnesses only (they scale the fallback retry and the P2 down) — production passes undefined */
  timingOverrides: Partial<EnforcementTiming> | undefined;
};

export function createEnergyDistributionEnforcement(environment: EnergyDistributionEnvironment) {
  // Per instance: a main() crash-restart (or the next harness) must warn about a still-invalid config again
  const correctionWarnings: CorrectionWarnings = { lastSummary: "" };
  const settings = createMemo(() =>
    correctedEnergyDistributionSettings(environment.config().inverter_energy_distribution, correctionWarnings)
  );
  const workingModeCode = createMemo(() => environment.workingModeCode());
  const [machineModel, setMachineModel] = createSignal<MachineModelReading | undefined>(undefined);
  const [hecs, setHecs] = createSignal<HecsReading | undefined>(undefined);
  const [episode, setEpisode] = createSignal<DivergenceEpisode | undefined>(undefined);
  // Primitives, so the status (and the ws) only moves when they do
  const [waitingReason, setWaitingReason] = createSignal<string | undefined>(undefined);
  const [judgedProfileName, setJudgedProfileName] = createSignal<EnergyDistributionProfileName | undefined>(undefined);
  const [lastEvent, setLastEvent] = createSignal<EnergyDistributionStatus["last_event"]>(undefined);
  const context: EnforcementContext = {
    ...environment,
    settings,
    workingModeCode,
    machineModel,
    hecs,
    episode,
    setEpisode,
    setWaitingReason,
    setJudgedProfileName,
    setLastEvent,
    lastReadbackRequestAtMs: undefined,
  };

  createEffect(() => {
    const round = environment.lastDecodedRound();
    if (round?.command === "HECS") setHecs({ fields: round.fields, decodedAtMs: round.decodedAt });
    if (round?.command !== "DM") return;
    const model = round.fields.machine_model;
    // The grid-off switch warns about a DM round without one
    if (typeof model !== "string") return;
    const previous = untrack(machineModel);
    setMachineModel({ model, atMs: round.decodedAt });
    // A DM change resets HECS, but the HECS beside this readback was read before it: read one after it
    if (previous && previous.model !== model) untrack(() => requestHecsReadback(context, "the machine model changed"));
  });
  createEffect<string | undefined>(previousCode => {
    const code = workingModeCode();
    if (previousCode !== undefined && code !== undefined && code !== previousCode) {
      untrack(() => requestHecsReadback(context, "the working mode changed"));
    }
    return code;
  });
  // The tick covers the passing of time: the fallback retry, the P2, a readback going stale
  createEffect(() => {
    hecs();
    machineModel();
    workingModeCode();
    environment.requestedMachineModel();
    settings();
    environment.config().usb_parameter_setting.poll_values_interval_seconds;
    untrack(() => evaluateEnforcement(context));
  });
  const tickTimer = setInterval(() => {
    // A throw out of a timer callback is an uncaught exception, i.e. a controller restart
    try {
      evaluateEnforcement(context);
    } catch (error) {
      errorLog("Energy distribution: evaluating the enforcement failed, retrying next tick", error);
    }
  }, ENFORCEMENT_TICK_INTERVAL_MS);
  onCleanup(() => clearInterval(tickTimer));

  const status = createMemo<EnergyDistributionStatus>(() => {
    const model = machineModel();
    const latestHecs = hecs();
    const runningEpisode = episode();
    const profileName: EnergyDistributionProfileName | undefined =
      judgedProfileName() ??
      (model && isWhitelistedMachineModel(model.model) ? PROFILE_BY_MACHINE_MODEL[model.model] : undefined);
    const shownProfile = settings()[profileName ?? "normal_hybrid"];
    return {
      profile_name: profileName,
      machine_model: model?.model,
      fields: ENERGY_DISTRIBUTION_FIELDS.map(field => {
        const inverterValue = latestHecs?.fields[field];
        return {
          field,
          desired: shownProfile[field],
          inverter: inverterValue === undefined ? undefined : String(inverterValue),
        };
      }),
      hecs_read_at: latestHecs?.decodedAtMs,
      divergence: runningEpisode && {
        since: runningEpisode.onsetMs,
        send_rounds: runningEpisode.sendRounds,
        p2_raised: runningEpisode.p2Raised,
        fallback_only: runningEpisode.changeTriggeredRetries >= CHANGE_TRIGGERED_RETRIES_PER_EPISODE,
      },
      waiting_reason: waitingReason(),
      last_event: lastEvent(),
    };
  });

  return { status };
}

type EnforcementContext = EnergyDistributionEnvironment & {
  settings: Accessor<InverterEnergyDistributionConfig>;
  workingModeCode: Accessor<string | undefined>;
  machineModel: Accessor<MachineModelReading | undefined>;
  hecs: Accessor<HecsReading | undefined>;
  episode: Accessor<DivergenceEpisode | undefined>;
  setEpisode: Setter<DivergenceEpisode | undefined>;
  setWaitingReason: Setter<string | undefined>;
  setJudgedProfileName: Setter<EnergyDistributionProfileName | undefined>;
  setLastEvent: Setter<EnergyDistributionStatus["last_event"]>;
  /** Wall-clock ms; the readbacks asked for on a DM or working mode change are at most one a minute */
  lastReadbackRequestAtMs: number | undefined;
};

/** Runs on every DM/HECS readback, working mode or config change and every tick; every read is untracked */
function evaluateEnforcement(context: EnforcementContext): void {
  const nowMs = context.wallClockNowMs();
  const settings = untrack(context.settings);
  const situation: EnforcementSituation = {
    nowMs,
    monotonicNowMs: context.monotonicNowMs(),
    machineModel: untrack(context.machineModel),
    workingModeCode: untrack(context.workingModeCode),
    machineModelSwitchPending: machineModelSwitchPending(
      untrack(context.machineModel),
      untrack(context.requestedMachineModel)
    ),
    hecs: untrack(context.hecs),
    settingsReadbackMaxAgeMs: machineModelReadbackMaxAgeMs(
      untrack(context.config).usb_parameter_setting.poll_values_interval_seconds
    ),
    profiles: settings,
    identicalSetterGateOpensAtMs: context.identicalSetterGateOpensAtMs,
  };
  const timing: EnforcementTiming = {
    p2AfterMs: settings.p2_after_minutes * 60_000,
    fallbackRetryMs: ENFORCEMENT_FALLBACK_RETRY_MS,
    ...context.timingOverrides,
  };
  const previousEpisode = untrack(context.episode);
  const step = nextEnforcementStep(previousEpisode, situation, timing);
  context.setEpisode(step.episode);
  context.setWaitingReason(step.waitingReason);
  context.setJudgedProfileName(step.judged?.profileName);
  const profileName = step.judged?.profileName;
  if (step.started && step.judged) {
    const profile = describeProfile(step.judged.profileName);
    warnLog(
      step.judged.divergences.length
        ? `Energy distribution: the inverter differs from the ${profile} profile: ${describeJudgement(step.judged)} — writing it`
        : `Energy distribution: the HECS readback lacks fields the ${profile} profile manages (${describeJudgement(step.judged)}) — not judged until they're read, a P2 if that takes p2_after_minutes`
    );
  }
  if (step.raiseP2 && step.episode) pageDivergence(context, step, step.episode, nowMs);
  if (step.send && step.episode) queueSetters(context, step.send, step.episode.sendRounds, profileName);
  if (step.landed) finishEpisode(context, step.landed, profileName, nowMs);
}

function queueSetters(
  context: EnforcementContext,
  divergences: readonly EnergyDistributionFieldDivergence[],
  sendRound: number,
  profileName: EnergyDistributionProfileName | undefined
): void {
  const commands: string[] = [];
  for (const divergence of divergences) {
    const { command, replacesPrefix } = setterForDivergence(divergence);
    commands.push(command);
    context.queueSetter({
      command,
      replacesPrefix,
      refreshAfterSend: ["HECS"],
      onResult: result => afterSetterResult(context, command, result),
    });
  }
  (sendRound === 1 ? logLog : warnLog)(
    `Energy distribution: ${sendRound === 1 ? "" : `round ${sendRound}, `}queueing ${commands.join(", ")} for the ${profileName ? describeProfile(profileName) : "current"} profile: ${describeDivergences(divergences)}`
  );
  recordEvent(context, `Writing ${commands.join(", ")}${sendRound === 1 ? "" : ` (round ${sendRound})`}`);
}

function afterSetterResult(context: EnforcementContext, command: string, result: SetterResult): void {
  if (result.acknowledged) return;
  // The session errorLogs a NAK once per streak of them; this says what the enforcement does about it
  warnLog(
    `Energy distribution: the inverter NAKed ${command} — retried once the DM, the working mode, an enforced HECS field or the profile changes (up to ${CHANGE_TRIGGERED_RETRIES_PER_EPISODE} times), else in ${ENFORCEMENT_FALLBACK_RETRY_MS / 60_000} min`
  );
  recordEvent(context, `${command} rejected by the inverter (NAK)`);
}

function pageDivergence(
  context: EnforcementContext,
  step: EnforcementStep,
  episode: DivergenceEpisode,
  nowMs: number
): void {
  warnLog(
    `Energy distribution: still differing ${Math.round((nowMs - episode.onsetMs) / 1000)} s after it was first seen (${step.judged ? describeJudgement(step.judged) : step.waitingReason}); paging P2`
  );
  recordEvent(context, "Still differing: P2 sent");
  raiseDivergenceNotLanded(context.raise, {
    episodeOnsetMs: episode.onsetMs,
    nowMs,
    sendRounds: episode.sendRounds,
    judged: step.judged,
    waitingReason: step.waitingReason,
  });
}

function finishEpisode(
  context: EnforcementContext,
  episode: DivergenceEpisode,
  profileName: EnergyDistributionProfileName | undefined,
  nowMs: number
): void {
  const profile = profileName ? describeProfile(profileName) : "current";
  const elapsedSeconds = Math.round((nowMs - episode.onsetMs) / 1000);
  logLog(
    episode.sendRounds
      ? `Energy distribution: the inverter holds the ${profile} profile again: ${describeDivergences(episode.firstDivergences)} (${episode.sendRounds} round(s), ${elapsedSeconds} s)`
      : `Energy distribution: the inverter matches the ${profile} profile again without a write (${elapsedSeconds} s)`
  );
  recordEvent(
    context,
    episode.sendRounds ? "Settings enforced: the readback matches the config" : "Matches the config"
  );
  if (episode.p2Raised) raiseDivergenceLandedAfterP2(context.raise, { episodeOnsetMs: episode.onsetMs, nowMs });
}

/** Judged on the enforcement's own DM reading, so the two can't disagree within one update */
function machineModelSwitchPending(
  machineModel: MachineModelReading | undefined,
  requestedMachineModel: MachineModelCode
): boolean {
  return machineModel !== undefined && machineModel.model !== requestedMachineModel;
}

function requestHecsReadback(context: EnforcementContext, why: string): void {
  const nowMs = context.wallClockNowMs();
  const lastRequestAtMs = context.lastReadbackRequestAtMs;
  if (lastRequestAtMs !== undefined && nowMs - lastRequestAtMs < SETTINGS_READBACK_REQUEST_LIFETIME_MS) return;
  context.lastReadbackRequestAtMs = nowMs;
  logLog(`Energy distribution: ${why} — reading HECS again`);
  context.requestSettingsReadback("HECS");
}

/** "Solar priority (SEP) Battery-Load-Grid → Load-Battery-Grid; not read: Feed to the utility (EDC)" */
function describeJudgement(judged: EnforcementJudgement): string {
  const unread = judged.unreadFields.length
    ? `not read: ${judged.unreadFields.map(field => ENERGY_DISTRIBUTION_FIELD_LABELS[field]).join(", ")}`
    : undefined;
  if (!judged.divergences.length) return unread ?? "none";
  return [describeDivergences(judged.divergences), unread].filter(part => part !== undefined).join("; ");
}

function describeProfile(profileName: EnergyDistributionProfileName): string {
  return profileName === "normal_hybrid" ? "050 (normal_hybrid)" : "151 (off_grid_iii)";
}

function recordEvent(context: EnforcementContext, what: string): void {
  context.setLastEvent({ what, when: context.wallClockNowMs() });
}

type CorrectionWarnings = { lastSummary: string };

/** The config section corrected to its bounds, warning once per distinct set of corrections */
function correctedEnergyDistributionSettings(
  configured: Config["inverter_energy_distribution"] | undefined,
  correctionWarnings: CorrectionWarnings
): InverterEnergyDistributionConfig {
  const { settings, corrections } = effectiveEnergyDistributionSettings(configured);
  const summary = corrections.join("; ");
  if (summary !== correctionWarnings.lastSummary) {
    if (summary) warnLog(`${summary} (the energy-distribution enforcement uses that until it's fixed)`);
    correctionWarnings.lastSummary = summary;
  }
  return settings;
}
