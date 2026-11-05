/**
 * The grid-off switch's context (useGridOffSwitch.ts builds it) and what reads it without acting: the
 * snapshot the decisions judge (gridOffDecisions.ts' GridOffSituation), the DM readback's bookkeeping, the
 * corrected settings, and the descriptions the log lines and events quote. What the switch does with it is
 * gridOffActions.ts.
 */
import { type Accessor, type Setter, untrack } from "solid-js";
import type { Config, GridOffConfig } from "../config/config.types.ts";
import type {
  DecodedFields,
  DecodedRound,
  MachineModelCode,
  SettingsQueryCommandName,
} from "../inverterComms/pi17Protocol.types.ts";
import type { SetterQueueItem } from "../inverterComms/inverterComms.types.ts";
import type { InverterValuesStore } from "../inverterComms/useInverterValues.ts";
import type { AlertManager } from "../alerting/alertManager.ts";
import { logLog, warnLog } from "../utilities/logging.ts";
import { describeMachineModel } from "../inverterComms/machineModel.ts";
import { effectiveGridOffSettings } from "./gridOffSettings.ts";
import {
  type GridOffSituation,
  machineModelReadbackMaxAgeMs,
  type StuckOffGridTracking,
  type SwitchBackSends,
} from "./gridOffDecisions.ts";
import type { OffGridFailures } from "./autoGridOffDecisions.ts";
import type { GridOffEvent } from "./gridOff.types.ts";

export type RequestedModel = { model: MachineModelCode; atMs: number | undefined };
export type MachineModelReadback = { model: string; atMs: number };

export type GridOffContext = {
  config: Accessor<Config>;
  settings: Accessor<GridOffConfig>;
  queueSetter: (item: SetterQueueItem) => void;
  /** Only GS's battery_voltage and PS's ac_output_total_active_power are read, for freshness */
  mqttValues: Pick<InverterValuesStore, "battery_voltage" | "ac_output_total_active_power">;
  soc: Accessor<number | undefined>;
  /** Wall-clock ms of the latest hall sensor 2 sample, the current the SOC integrates; undefined = none yet */
  socSampleAtMs: Accessor<number | undefined>;
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
  /** The latest switch either way, page, automatic, guard or startup fail-safe (the rate limit on 151) */
  lastSwitchAtMs: number | undefined;
  /**
   * Switches to 151 that didn't hold (NAKed, never read back, reverted for stale readings or an unknown SOC)
   * since the last routine switch back: automatic grid-off's retry back-off
   */
  offGridFailures: OffGridFailures;
};

/** Main: the snapshot the decisions judge, read now (callers untrack it) */
export function currentSituation(context: GridOffContext): GridOffSituation {
  const nowMs = context.wallClockNowMs();
  const config = context.config();
  const batteryVoltage = context.mqttValues.battery_voltage;
  const outputPower = context.mqttValues.ac_output_total_active_power;
  const readback = context.readback();
  const socSampleAtMs = context.socSampleAtMs();
  return {
    nowMs,
    soc: context.soc(),
    socReadingAgeMs: socSampleAtMs === undefined ? undefined : nowMs - socSampleAtMs,
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

export function recordEvent(context: GridOffContext, what: string): void {
  context.setLastEvent({ what, when: context.wallClockNowMs() });
}

export function describeSituation(situation: GridOffSituation): string {
  const soc = situation.soc === undefined ? "unknown" : `${situation.soc.toFixed(1)} %`;
  return `SOC ${soc} (hall sample ${describeAge(situation.socReadingAgeMs)}), inverter readings ${describeAge(situation.inverterReadingAgeMs)}, DM readback ${describeMachineModel(situation.readbackModel)}`;
}

/** Every field of the latest GPMP/HECS/BATS/DM rounds as one line: did a model change reset any of them? */
export function describeSettings(context: GridOffContext): string {
  return JSON.stringify(context.latestSettingsFields);
}

/** The settings rounds kept whole for the before/after log (did the model change reset anything?) */
const LOGGED_SETTINGS_QUERIES: readonly SettingsQueryCommandName[] = ["GPMP", "HECS", "BATS", "DM"];

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

function describeAge(ageMs: number | undefined): string {
  return ageMs === undefined ? "none" : `${Math.round(ageMs / 1000)} s old`;
}
