/**
 * What the grid-off switch does on a request, a guard run or a setter result, on the switch's context
 * (useGridOffSwitch.ts builds it and the reactivity around it): the page's requests, the guards and the
 * startup fail-safe, the resend back-off and the stuck P1, and the log lines that say why.
 */
import { type Accessor, type Setter, untrack } from "solid-js";
import type { Config, GridOffConfig } from "../config/config.types.ts";
import type {
  DecodedFields,
  DecodedRound,
  MachineModelCode,
  SettingsQueryCommandName,
} from "../inverterComms/pi17Protocol.types.ts";
import type { SetterQueueItem, SetterResult } from "../inverterComms/inverterComms.types.ts";
import type { InverterValuesStore } from "../inverterComms/useInverterValues.ts";
import type { AlertManager } from "../alerting/alertManager.ts";
import { errorLog, logLog, warnLog } from "../utilities/logging.ts";
import {
  describeMachineModel,
  machineModelSetterCommand,
  NORMAL_HYBRID_MODEL,
  OFF_GRID_III_MODEL,
} from "../inverterComms/machineModel.ts";
import { effectiveGridOffSettings } from "./gridOffSettings.ts";
import {
  type GridOffSituation,
  machineModelReadbackMaxAgeMs,
  NO_SWITCH_BACK_SENDS,
  reconcileMachineModel,
  revertReason,
  type StuckOffGridTracking,
  SWITCH_CONFIRM_DEADLINE_MS,
  type SwitchBackSends,
  switchBackResendDue,
  switchOffGridRefusal,
  trackStuckOffGrid,
} from "./gridOffDecisions.ts";
import type { GridOffEvent } from "./gridOff.types.ts";
import { raiseStuckOffGrid, raiseStuckOffGridResolved } from "./gridOffStuckAlert.ts";

/** The settings rounds kept whole for the before/after log (did the model change reset anything?) */
const LOGGED_SETTINGS_QUERIES: readonly SettingsQueryCommandName[] = ["GPMP", "HECS", "BATS", "DM"];

export type RequestedModel = { model: MachineModelCode; atMs: number | undefined };
export type MachineModelReadback = { model: string; atMs: number };

export type GridOffContext = {
  config: Accessor<Config>;
  settings: Accessor<GridOffConfig>;
  queueSetter: (item: SetterQueueItem) => void;
  /** Only GS's battery_voltage and PS's ac_output_total_active_power are read, for freshness */
  mqttValues: Pick<InverterValuesStore, "battery_voltage" | "ac_output_total_active_power">;
  soc: Accessor<number | undefined>;
  raise: AlertManager["raise"];
  wallClockNowMs: () => number;
  requested: Accessor<RequestedModel>;
  setRequested: Setter<RequestedModel>;
  readback: Accessor<MachineModelReadback | undefined>;
  setLastEvent: Setter<GridOffEvent | undefined>;
  stuckTracking: Accessor<StuckOffGridTracking>;
  setStuckTracking: Setter<StuckOffGridTracking>;
  /** DM readbacks since the start: the first one is what the startup fail-safe judges */
  readbackCount: number;
  /** The reconciliation reason last logged, so a standing one logs once, not every tick */
  lastReconciliationReason: string | undefined;
  /** The latest whole GPMP/HECS/BATS/DM rounds, every field (battery type, cut-offs, …), for the log */
  latestSettingsFields: Partial<Record<SettingsQueryCommandName, DecodedFields>>;
  /** DM050s queued since the inverter started reading 151 while 050 is wanted (the resend back-off) */
  switchBackSends: SwitchBackSends;
  /** The latest switch either way, page or guard (the rate limit on 151) */
  lastSwitchAtMs: number | undefined;
};

export function recordMachineModelReadback(
  context: GridOffContext,
  round: DecodedRound,
  setReadback: Setter<MachineModelReadback | undefined>
): void {
  const model = round.fields.machine_model;
  if (typeof model !== "string") {
    warnLog("Grid off: a DM round decoded without a machine_model string:", JSON.stringify(round.fields));
    return;
  }
  const previous = untrack(context.readback);
  context.readbackCount++;
  setReadback({ model, atMs: round.decodedAt });
  if (previous?.model === model) return;
  // The confirm and settings rounds read DM last, so the settings beside it are this round's too
  logLog(
    `Grid off: DM readback ${previous ? describeMachineModel(previous.model) : "(first since start)"} → ${describeMachineModel(model)};`,
    `settings read with it: ${describeSettings(context)}`
  );
}

export function requestOffGrid(context: GridOffContext): string {
  const situation = untrack(() => currentSituation(context));
  const refusal =
    untrack(context.requested).model === OFF_GRID_III_MODEL
      ? "151 is already requested"
      : switchOffGridRefusal(situation, untrack(context.settings));
  if (refusal) {
    logLog("Grid off: switching to 151 (Off-Grid III) refused:", refusal);
    recordEvent(context, `Switching to 151 refused: ${refusal}`);
    throw new Error(`Refused: ${refusal}`);
  }
  logLog(
    `Grid off: requested by the page — queueing DM${OFF_GRID_III_MODEL} (Off-Grid III, grid relay open);`,
    describeSituation(situation),
    `settings before: ${describeSettings(context)}`
  );
  // Queued before the request flips: should the guards' run on the flip switch back at once, their DM050
  // replaces this DM151 in the queue rather than being replaced by it
  queueMachineModel(context, OFF_GRID_III_MODEL, result => afterOffGridResult(context, result));
  context.lastSwitchAtMs = situation.nowMs;
  context.setRequested({ model: OFF_GRID_III_MODEL, atMs: situation.nowMs });
  recordEvent(context, "151 requested from the page: DM151 queued, waiting for the inverter's ACK and readback");
  return "DM151 queued: the DM readback confirms it in ~10–15 s";
}

/** Never refused or rate-limited: back to normal must always be possible */
export function requestNormal(context: GridOffContext): string {
  const situation = untrack(() => currentSituation(context));
  logLog(
    `Grid off: back to normal requested by the page — queueing DM${NORMAL_HYBRID_MODEL};`,
    describeSituation(situation)
  );
  queueSwitchBack(context, "the page's request", situation.nowMs);
  context.lastSwitchAtMs = situation.nowMs;
  context.setRequested({ model: NORMAL_HYBRID_MODEL, atMs: situation.nowMs });
  recordEvent(context, "050 requested from the page");
  return untrack(context.readback)?.model === NORMAL_HYBRID_MODEL
    ? "The inverter already reads 050: nothing to send"
    : "DM050 queued: the DM readback confirms it in ~10–15 s";
}

/** Runs on every request/readback/SOC/config change and every guard tick; every read is untracked */
export function evaluateGuards(context: GridOffContext): void {
  const requested = untrack(context.requested);
  const situation = untrack(() => currentSituation(context));
  const settings = untrack(context.settings);
  if (requested.model === OFF_GRID_III_MODEL) {
    const reason = revertReason(situation, settings, requested.atMs ?? situation.nowMs);
    if (reason) {
      switchBack(context, reason, situation);
      return;
    }
  }
  updateStuckTracking(context, requested.model, situation, settings);
  if (situation.readbackModel !== OFF_GRID_III_MODEL) context.switchBackSends = NO_SWITCH_BACK_SENDS;
  const reconciliation = reconcileMachineModel({
    requestedModel: requested.model,
    readbackModel: situation.readbackModel,
    firstReadbackSinceStart: context.readbackCount === 1,
  });
  const reasonToLog = reconciliation.action === "none" ? undefined : reconciliation.reason;
  if (reasonToLog !== context.lastReconciliationReason) {
    // Within the confirm window of an explicit 050 request (the page's or a guard's) a 151 readback is that
    // switch-back still landing: its own log line and event already say why
    const followingUpRequest =
      requested.atMs !== undefined && situation.nowMs - requested.atMs < SWITCH_CONFIRM_DEADLINE_MS;
    if (reconciliation.action === "switch_back" && followingUpRequest) {
      logLog(
        `Grid off: the inverter still reads 151 — DM${NORMAL_HYBRID_MODEL} is resent with back-off until it reads 050`
      );
    } else if (reconciliation.action === "switch_back") {
      warnLog(`Grid off: ${reconciliation.reason} — queueing DM${NORMAL_HYBRID_MODEL};`, describeSituation(situation));
      recordEvent(context, `Switching back to 050: ${reconciliation.reason}`);
    } else if (reconciliation.action === "leave_alone") {
      warnLog(`Grid off: ${reconciliation.reason}`);
      recordEvent(context, reconciliation.reason);
    }
    context.lastReconciliationReason = reasonToLog;
  }
  if (reconciliation.action === "switch_back" && switchBackResendDue(context.switchBackSends, situation.nowMs)) {
    if (context.switchBackSends.count > 0) {
      warnLog(
        `Grid off: the inverter still reads 151 — resending DM${NORMAL_HYBRID_MODEL} (send ${context.switchBackSends.count + 1})`
      );
    }
    queueSwitchBack(context, reconciliation.reason, situation.nowMs);
  }
}

function updateStuckTracking(
  context: GridOffContext,
  requestedModel: MachineModelCode,
  situation: GridOffSituation,
  settings: GridOffConfig
): void {
  const previous = untrack(context.stuckTracking);
  const next = trackStuckOffGrid(
    previous,
    { requestedModel, readbackModel: situation.readbackModel, nowMs: situation.nowMs },
    settings
  );
  context.setStuckTracking(next);
  if (next.stuck && !previous.stuck) {
    const stuckForMs = situation.nowMs - (next.conditionSinceMs ?? situation.nowMs);
    warnLog(
      `Grid off: STUCK — the inverter reads 151 ${Math.round(stuckForMs / 1000)} s after 050 was wanted;`,
      `${context.switchBackSends.count} DM050 sent; paging P1, buying and the grid alerts resume`
    );
    recordEvent(context, "Stuck on 151 while 050 is wanted: P1 sent, DM050 resent with back-off");
    raiseStuckOffGrid(context.raise, {
      stuckForMs,
      switchBackSends: context.switchBackSends.count,
      why: context.lastReconciliationReason ?? "a switch back to 050",
    });
  } else if (previous.stuck && !next.stuck && previous.conditionSinceMs !== undefined) {
    logLog("Grid off: no longer stuck — the inverter reads", describeMachineModel(situation.readbackModel));
    recordEvent(context, "No longer stuck on 151");
    raiseStuckOffGridResolved(context.raise, situation.nowMs - previous.conditionSinceMs);
  }
}

function switchBack(context: GridOffContext, reason: string, situation: GridOffSituation): void {
  warnLog(`Grid off: guard switching back to 050 — ${reason};`, describeSituation(situation));
  queueSwitchBack(context, reason, situation.nowMs);
  context.lastSwitchAtMs = situation.nowMs;
  // The flip re-runs the guards at once; their follow-up only logs (followingUpRequest)
  context.setRequested({ model: NORMAL_HYBRID_MODEL, atMs: situation.nowMs });
  recordEvent(context, `Guard switched back to 050: ${reason}`);
}

/** A DM050 that counts towards the resend back-off */
function queueSwitchBack(context: GridOffContext, why: string, nowMs: number): void {
  context.switchBackSends = { count: context.switchBackSends.count + 1, lastAtMs: nowMs };
  queueMachineModel(context, NORMAL_HYBRID_MODEL, result => afterNormalResult(context, result, why));
}

export function queueMachineModel(
  context: GridOffContext,
  model: MachineModelCode,
  onResult: (result: SetterResult) => void
): void {
  context.queueSetter({
    command: machineModelSetterCommand(model),
    replacesPrefix: "DM",
    // Did the model change reset anything? The first confirm re-reads every setting, DM last
    refreshAfterSend: ["GPMP", "HECS", "BATS", "DM"],
    onResult,
  });
}

function afterOffGridResult(context: GridOffContext, result: SetterResult): void {
  // A guard may have switched back while DM151 was on the wire: its event stays the latest word
  const stillRequested = untrack(context.requested).model === OFF_GRID_III_MODEL;
  if (result.acknowledged) {
    logLog(`Grid off: the inverter ACKed DM${OFF_GRID_III_MODEL}; the DM readback confirms whether it applied`);
    if (stillRequested) recordEvent(context, "DM151 ACKed: waiting for the DM readback to show 151");
    return;
  }
  // Nothing changed on the inverter: the request must not keep feeding and buying on hold
  errorLog(`Grid off: the inverter REJECTED DM${OFF_GRID_III_MODEL} (NAK) — the request goes back to 050`);
  if (!stillRequested) return;
  const nowMs = context.wallClockNowMs();
  context.lastSwitchAtMs = nowMs;
  context.setRequested({ model: NORMAL_HYBRID_MODEL, atMs: nowMs });
  recordEvent(context, "DM151 rejected by the inverter (NAK): back to 050");
}

function afterNormalResult(context: GridOffContext, result: SetterResult, why: string): void {
  if (result.acknowledged) {
    logLog(
      `Grid off: the inverter ACKed DM${NORMAL_HYBRID_MODEL} (${why}); the DM readback confirms whether it applied`
    );
    recordEvent(context, "DM050 ACKed: waiting for the DM readback to show 050");
    return;
  }
  errorLog(
    `Grid off: the inverter REJECTED DM${NORMAL_HYBRID_MODEL} (NAK) while switching back (${why}) — resent with back-off while it reads 151`
  );
  recordEvent(context, "DM050 rejected by the inverter (NAK): resent with back-off while it reads 151");
}

function currentSituation(context: GridOffContext): GridOffSituation {
  const nowMs = context.wallClockNowMs();
  const config = context.config();
  const batteryVoltage = context.mqttValues.battery_voltage;
  const outputPower = context.mqttValues.ac_output_total_active_power;
  const readback = context.readback();
  return {
    nowMs,
    soc: context.soc(),
    // GS gives the battery voltage, PS the output power: either one going quiet means the link is down
    inverterReadingAgeMs:
      batteryVoltage && outputPower ? nowMs - Math.min(batteryVoltage.time, outputPower.time) : undefined,
    readbackModel: readback?.model,
    readbackAgeMs: readback ? nowMs - readback.atMs : undefined,
    readbackMaxAgeMs: machineModelReadbackMaxAgeMs(config.usb_parameter_setting.poll_values_interval_seconds),
    lastSwitchAtMs: context.lastSwitchAtMs,
    sellSchedule: config.scheduled_power_selling.schedule,
    buySchedule: config.scheduled_power_buying.schedule,
  };
}

function recordEvent(context: GridOffContext, what: string): void {
  context.setLastEvent({ what, when: context.wallClockNowMs() });
}

function describeSituation(situation: GridOffSituation): string {
  const soc = situation.soc === undefined ? "unknown" : `${situation.soc.toFixed(1)} %`;
  const readingAge =
    situation.inverterReadingAgeMs === undefined
      ? "none"
      : `${Math.round(situation.inverterReadingAgeMs / 1000)} s old`;
  return `SOC ${soc}, inverter readings ${readingAge}, DM readback ${describeMachineModel(situation.readbackModel)}`;
}

/** Every field of the latest GPMP/HECS/BATS/DM rounds as one line: did a model change reset any of them? */
function describeSettings(context: GridOffContext): string {
  return JSON.stringify(context.latestSettingsFields);
}

export function isLoggedSettingsQuery(command: DecodedRound["command"]): command is SettingsQueryCommandName {
  return LOGGED_SETTINGS_QUERIES.some(settingsQuery => settingsQuery === command);
}

let lastWarnedCorrections = "";

/** The knobs corrected to their bounds, warning once per distinct set of corrections */
export function correctedGridOffSettings(configured: Config["grid_off"] | undefined): GridOffConfig {
  const { settings, corrections } = effectiveGridOffSettings(configured);
  const summary = corrections.join("; ");
  if (summary !== lastWarnedCorrections) {
    if (summary) warnLog(`${summary} (the grid-off switch uses that until it's fixed)`);
    lastWarnedCorrections = summary;
  }
  return settings;
}
