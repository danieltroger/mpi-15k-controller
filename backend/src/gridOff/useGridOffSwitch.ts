/**
 * The grid-off switch's live wiring: the page asks for Off-Grid III (machine model 151, the grid relay open
 * on battery) or normal hybrid (050); the guards switch back to 050 on a low SOC, an upcoming buy or sell
 * window, stale readings or a 151 that never applied; a clean stop switches back (gridOffShutdown.ts); and a
 * 151 read while 050 is wanted, at startup above all, is switched back too. Nothing here writes on its own
 * initiative except DM050, and only while the inverter reads 151. Decisions: gridOffDecisions.ts.
 */
import { type Accessor, createEffect, createMemo, createSignal, onCleanup, type Setter, untrack } from "solid-js";
import type { Config, GridOffConfig } from "../config/config.types.ts";
import type { DecodedRound, MachineModelCode } from "../inverterComms/pi17Protocol.types.ts";
import type { SetterQueueItem, SetterResult, UsbValues } from "../inverterComms/inverterComms.types.ts";
import type { InverterValuesStore } from "../inverterComms/useInverterValues.ts";
import { useInverterComms } from "../inverterComms/InverterCommsProvider.ts";
import { useFromMqttProvider } from "../mqttValues/MQTTValuesProvider.ts";
import { useBatteryValuesProvider } from "../battery/BatteryValuesProvider.ts";
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
  reconcileMachineModel,
  revertReason,
  SWITCH_CONFIRM_DEADLINE_MS,
  switchOffGridRefusal,
} from "./gridOffDecisions.ts";
import type { GridOffEvent, GridOffStatus } from "./gridOff.types.ts";
import { holdGridOffThroughShutdown } from "./gridOffShutdown.ts";

/** How often the time-based guards (SOC, windows, staleness, the confirm deadline) are re-judged */
const GUARD_TICK_INTERVAL_MS = 10_000;

export function useGridOffSwitch({ config }: { config: Accessor<Config> }) {
  const { $usbValues, queueSetter, lastDecodedRound } = useInverterComms();
  const { mqttValues } = useFromMqttProvider();
  const { clampedSocAh } = useBatteryValuesProvider();
  return createGridOffSwitch({
    config,
    usbValues: $usbValues,
    queueSetter,
    lastDecodedRound,
    mqttValues,
    soc: clampedSocAh,
    wallClockNowMs: () => Date.now(),
  });
}

/** Everything the switch reads and writes, as plain accessors so a selftest can build the graph */
export type GridOffEnvironment = {
  config: Accessor<Config>;
  /** The settings readback store (logged around a switch: did it reset anything?) */
  usbValues: UsbValues;
  queueSetter: (item: SetterQueueItem) => void;
  lastDecodedRound: Accessor<DecodedRound | undefined>;
  /** Only GS's battery_voltage and PS's ac_output_total_active_power are read, for freshness */
  mqttValues: Pick<InverterValuesStore, "battery_voltage" | "ac_output_total_active_power">;
  /** THE SOC (clampedSocAh) */
  soc: Accessor<number | undefined>;
  /** Date.now() in production */
  wallClockNowMs: () => number;
};

export function createGridOffSwitch(environment: GridOffEnvironment) {
  const { config, usbValues, queueSetter, lastDecodedRound, mqttValues, soc, wallClockNowMs } = environment;
  // Never persisted: every controller start wants 050, which is what makes a 151 at startup switch back
  const [requested, setRequested] = createSignal<RequestedModel>({ model: NORMAL_HYBRID_MODEL, atMs: undefined });
  const [readback, setReadback] = createSignal<MachineModelReadback | undefined>(undefined);
  const [lastEvent, setLastEvent] = createSignal<GridOffEvent | undefined>(undefined);
  const settings = createMemo(() => correctedGridOffSettings(config().grid_off));
  const context: GridOffContext = {
    config,
    settings,
    queueSetter,
    usbValues,
    mqttValues,
    soc,
    wallClockNowMs,
    requested,
    setRequested,
    readback,
    setLastEvent,
    readbackCount: 0,
    lastReconciliationReason: undefined,
  };

  createEffect(() => {
    const round = lastDecodedRound();
    if (round?.command !== "DM") return;
    const model = round.fields.machine_model;
    if (typeof model !== "string") {
      warnLog("Grid off: a DM round decoded without a machine_model string:", JSON.stringify(round.fields));
      return;
    }
    const previous = untrack(readback);
    context.readbackCount++;
    setReadback({ model, atMs: round.decodedAt });
    if (previous?.model !== model) {
      // The confirm and settings rounds read DM last, so the other settings beside it are this round's too.
      // Untracked: this effect must re-run per DM round only, not per settings change.
      logLog(
        `Grid off: DM readback ${previous ? describeMachineModel(previous.model) : "(first since start)"} → ${describeMachineModel(model)};`,
        `settings read with it: ${untrack(() => describeSettings(usbValues))}`
      );
    }
  });

  const gridOffInForce = createMemo(
    () => requested().model === OFF_GRID_III_MODEL || readback()?.model === OFF_GRID_III_MODEL
  );
  createEffect(() =>
    logLog(
      gridOffInForce()
        ? "Grid off in force: the night feed and buy windows hold their inverter writes, the grid alerts stand down"
        : "Grid off not in force: feeding, buying and the grid alerts run normally"
    )
  );

  // Reactive on what can trip a guard at once (a SOC update, a window added that is already running); the
  // tick covers the passing of time
  createEffect(() => {
    requested();
    readback();
    soc();
    config();
    untrack(() => evaluateGuards(context));
  });
  const guardTimer = setInterval(() => {
    // A throw out of a timer callback is an uncaught exception, i.e. a controller restart
    try {
      evaluateGuards(context);
    } catch (error) {
      errorLog("Grid off: evaluating the guards failed, retrying next tick", error);
    }
  }, GUARD_TICK_INTERVAL_MS);
  onCleanup(() => clearInterval(guardTimer));

  holdGridOffThroughShutdown({
    gridOffInForce,
    waitSeconds: () => settings().shutdown_wait_seconds,
    sendNormalHybrid: onResult => queueMachineModel(context, NORMAL_HYBRID_MODEL, onResult),
  });

  const status = createMemo<GridOffStatus>(() => ({
    requested_model: requested().model,
    requested_at: requested().atMs,
    readback_model: readback()?.model,
    readback_at: readback()?.atMs,
    grid_off_in_force: gridOffInForce(),
    last_event: lastEvent(),
  }));

  return {
    /** 151 requested or read back: feeding/buying writes hold, the grid alerts stand down */
    gridOffInForce,
    status,
    /** The page's "open the grid relay" (DM151): refused, with the reason thrown, unless every precondition holds */
    requestOffGrid: async () => requestOffGrid(context),
    /** The page's "back to normal" (DM050): always allowed */
    requestNormal: async () => requestNormal(context),
  };
}

type RequestedModel = { model: MachineModelCode; atMs: number | undefined };
type MachineModelReadback = { model: string; atMs: number };

type GridOffContext = {
  config: Accessor<Config>;
  settings: Accessor<GridOffConfig>;
  queueSetter: (item: SetterQueueItem) => void;
  usbValues: UsbValues;
  mqttValues: GridOffEnvironment["mqttValues"];
  soc: Accessor<number | undefined>;
  wallClockNowMs: () => number;
  requested: Accessor<RequestedModel>;
  setRequested: Setter<RequestedModel>;
  readback: Accessor<MachineModelReadback | undefined>;
  setLastEvent: Setter<GridOffEvent | undefined>;
  /** DM readbacks since the start: the first one is what the startup fail-safe judges */
  readbackCount: number;
  /** The reconciliation reason last logged, so a standing one logs once, not every tick */
  lastReconciliationReason: string | undefined;
};

function requestOffGrid(context: GridOffContext): string {
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
    `settings before: ${describeSettings(context.usbValues)}`
  );
  // Queued before the request flips: should the guards' run on the flip switch back at once, their DM050
  // replaces this DM151 in the queue rather than being replaced by it
  queueMachineModel(context, OFF_GRID_III_MODEL, result => afterOffGridResult(context, result));
  context.setRequested({ model: OFF_GRID_III_MODEL, atMs: situation.nowMs });
  recordEvent(context, "151 requested from the page: DM151 queued, waiting for the inverter's ACK and readback");
  return "DM151 queued: the DM readback confirms it in ~10–15 s";
}

function requestNormal(context: GridOffContext): string {
  const situation = untrack(() => currentSituation(context));
  logLog(
    `Grid off: back to normal requested by the page — queueing DM${NORMAL_HYBRID_MODEL};`,
    describeSituation(situation)
  );
  queueMachineModel(context, NORMAL_HYBRID_MODEL, result => afterNormalResult(context, result, "the page's request"));
  context.setRequested({ model: NORMAL_HYBRID_MODEL, atMs: situation.nowMs });
  recordEvent(context, "050 requested from the page");
  return untrack(context.readback)?.model === NORMAL_HYBRID_MODEL
    ? "The inverter already reads 050: nothing to send"
    : "DM050 queued: the DM readback confirms it in ~10–15 s";
}

/** Runs on every request/readback change and every guard tick; every read is untracked */
function evaluateGuards(context: GridOffContext): void {
  const requested = untrack(context.requested);
  const situation = untrack(() => currentSituation(context));
  if (requested.model === OFF_GRID_III_MODEL) {
    const reason = revertReason(situation, untrack(context.settings), requested.atMs ?? situation.nowMs);
    if (reason) {
      switchBack(context, reason, situation);
      return;
    }
  }
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
      logLog(`Grid off: the inverter still reads 151 — DM${NORMAL_HYBRID_MODEL} stays queued until it reads 050`);
    } else if (reconciliation.action === "switch_back") {
      warnLog(`Grid off: ${reconciliation.reason} — queueing DM${NORMAL_HYBRID_MODEL};`, describeSituation(situation));
      recordEvent(context, `Switching back to 050: ${reconciliation.reason}`);
    } else if (reconciliation.action === "leave_alone") {
      warnLog(`Grid off: ${reconciliation.reason}`);
      recordEvent(context, reconciliation.reason);
    }
    context.lastReconciliationReason = reasonToLog;
  }
  // Desired state on every tick while the inverter reads 151: the session drops it once the readback shows
  // 050 and its identical-setter gate spaces the resends (60 s)
  if (reconciliation.action === "switch_back") {
    queueMachineModel(context, NORMAL_HYBRID_MODEL, result =>
      afterNormalResult(context, result, reconciliation.reason)
    );
  }
}

function switchBack(context: GridOffContext, reason: string, situation: GridOffSituation): void {
  warnLog(`Grid off: guard switching back to 050 — ${reason};`, describeSituation(situation));
  queueMachineModel(context, NORMAL_HYBRID_MODEL, result => afterNormalResult(context, result, reason));
  // The flip re-runs the guards at once; their follow-up only logs (followingUpRequest)
  context.setRequested({ model: NORMAL_HYBRID_MODEL, atMs: situation.nowMs });
  recordEvent(context, `Guard switched back to 050: ${reason}`);
}

function queueMachineModel(
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
  if (result.acknowledged) {
    logLog(`Grid off: the inverter ACKed DM${OFF_GRID_III_MODEL}; the DM readback confirms whether it applied`);
    recordEvent(context, "DM151 ACKed: waiting for the DM readback to show 151");
    return;
  }
  // Nothing changed on the inverter: the request must not keep feeding and buying on hold
  errorLog(`Grid off: the inverter REJECTED DM${OFF_GRID_III_MODEL} (NAK) — the request goes back to 050`);
  if (untrack(context.requested).model === OFF_GRID_III_MODEL) {
    context.setRequested({ model: NORMAL_HYBRID_MODEL, atMs: context.wallClockNowMs() });
  }
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
    `Grid off: the inverter REJECTED DM${NORMAL_HYBRID_MODEL} (NAK) while switching back (${why}) — it is resent while the readback shows 151`
  );
  recordEvent(context, "DM050 rejected by the inverter (NAK): resending while it reads 151");
}

function currentSituation(context: GridOffContext): GridOffSituation {
  const nowMs = context.wallClockNowMs();
  const config = context.config();
  const batteryVoltage = context.mqttValues.battery_voltage;
  const outputPower = context.mqttValues.ac_output_total_active_power;
  return {
    nowMs,
    soc: context.soc(),
    // GS gives the battery voltage, PS the output power: either one going quiet means the link is down
    inverterReadingAgeMs:
      batteryVoltage && outputPower ? nowMs - Math.min(batteryVoltage.time, outputPower.time) : undefined,
    readbackModel: context.readback()?.model,
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

/** The settings store as one line: did a model change reset any of them? */
function describeSettings(usbValues: UsbValues): string {
  return JSON.stringify({ ...usbValues });
}

let lastWarnedCorrections = "";

/** The knobs corrected to their bounds, warning once per distinct set of corrections */
function correctedGridOffSettings(configured: Config["grid_off"] | undefined): GridOffConfig {
  const { settings, corrections } = effectiveGridOffSettings(configured);
  const summary = corrections.join("; ");
  if (summary !== lastWarnedCorrections) {
    if (summary) warnLog(`${summary} (the grid-off switch uses that until it's fixed)`);
    lastWarnedCorrections = summary;
  }
  return settings;
}
