/**
 * What the grid-off switch does on a request, a guard run or a setter result, on the switch's context
 * (gridOffContext.ts; useGridOffSwitch.ts builds it and the reactivity around it): the page's and automatic
 * grid-off's requests, the guards and the startup fail-safe, the resend back-off and the stuck P1, the
 * failed-switch count automatic grid-off backs off on, and the log lines that say why.
 */
import { untrack } from "solid-js";
import type { GridOffConfig } from "../config/config.types.ts";
import type { MachineModelCode } from "../inverterComms/pi17Protocol.types.ts";
import type { SetterResult } from "../inverterComms/inverterComms.types.ts";
import { errorLog, logLog, warnLog } from "../utilities/logging.ts";
import {
  describeMachineModel,
  machineModelSetterCommand,
  NORMAL_HYBRID_MODEL,
  OFF_GRID_III_MODEL,
} from "../inverterComms/machineModel.ts";
import {
  FAILED_SWITCH_REVERT_KINDS,
  type GridOffSituation,
  NO_SWITCH_BACK_SENDS,
  reconcileMachineModel,
  type RevertCause,
  revertCause,
  SWITCH_CONFIRM_DEADLINE_MS,
  switchBackResendDue,
  switchOffGridRefusal,
  trackStuckOffGrid,
} from "./gridOffDecisions.ts";
import { describeWindowConflict, NO_OFF_GRID_FAILURES } from "./autoGridOffDecisions.ts";
import {
  currentSituation,
  describeSettings,
  describeSituation,
  type GridOffContext,
  recordEvent,
} from "./gridOffContext.ts";
import { raiseStuckOffGrid, raiseStuckOffGridResolved } from "./gridOffStuckAlert.ts";

/** Why the page's buttons are refused while automatic grid-off drives the switch */
const AUTO_ENABLED_REFUSAL =
  "automatic grid-off is on (grid_off.auto_enabled): turn it off on the config page to switch by hand";

/** Who asks the switch for a model: the page's buttons, or automatic grid-off with its reason */
export type SwitchRequester = { by: "page" } | { by: "auto"; reason: string };

/**
 * Whether a switch back to 050 ends the stretch off the grid as planned ("routine": a window, the battery, the
 * page, automatic grid-off turned off), which clears the failed-switch count, or because it didn't hold
 * ("failed": the SOC unknown), which adds to it
 */
export type SwitchBackOutcome = "routine" | "failed";

/**
 * A request for 151, from the page or automatic grid-off: refused, with the reason thrown, unless every
 * precondition holds (and, from the page, unless automatic grid-off is on)
 */
export function requestOffGrid(context: GridOffContext, requester: SwitchRequester): string {
  const situation = untrack(() => currentSituation(context));
  const refusal =
    untrack(context.requested).model === OFF_GRID_III_MODEL
      ? "151 is already requested"
      : requester.by === "page" && untrack(context.settings).auto_enabled
        ? AUTO_ENABLED_REFUSAL
        : switchOffGridRefusal(situation, untrack(context.settings));
  if (refusal) {
    logLog(`Grid off: switching to 151 (Off-Grid III) ${describeRequester(requester)} refused:`, refusal);
    recordEvent(context, `Switching to 151 refused: ${refusal}`);
    throw new Error(`Refused: ${refusal}`);
  }
  logLog(
    `Grid off: requested ${describeRequester(requester)} — queueing DM${OFF_GRID_III_MODEL} (Off-Grid III, grid relay open);`,
    describeSituation(situation),
    `settings before: ${describeSettings(context)}`
  );
  // Queued before the request flips: should the guards' run on the flip switch back at once, their DM050
  // replaces this DM151 in the queue rather than being replaced by it
  queueMachineModel(context, OFF_GRID_III_MODEL, result => afterOffGridResult(context, result));
  context.lastSwitchAtMs = situation.nowMs;
  context.setRequested({ model: OFF_GRID_III_MODEL, atMs: situation.nowMs });
  recordEvent(
    context,
    `151 requested ${describeRequester(requester)}: DM151 queued, waiting for the inverter's ACK and readback`
  );
  return "DM151 queued: the DM readback confirms it in ~10–15 s";
}

/**
 * A request for 050. Never rate-limited, and automatic grid-off's always goes out; the page's is refused only
 * while automatic grid-off is on, which turning it off ends (and that switches back by itself)
 */
export function requestNormal(context: GridOffContext, requester: SwitchRequester, outcome: SwitchBackOutcome): string {
  const situation = untrack(() => currentSituation(context));
  if (requester.by === "page" && untrack(context.settings).auto_enabled) {
    logLog("Grid off: back to normal from the page refused:", AUTO_ENABLED_REFUSAL);
    recordEvent(context, `Back to 050 refused: ${AUTO_ENABLED_REFUSAL}`);
    throw new Error(`Refused: ${AUTO_ENABLED_REFUSAL}`);
  }
  logLog(
    `Grid off: back to normal requested ${describeRequester(requester)} — queueing DM${NORMAL_HYBRID_MODEL};`,
    describeSituation(situation)
  );
  settleOffGridFailures(context, outcome, situation.nowMs);
  queueSwitchBack(
    context,
    requester.by === "page" ? "the page's request" : `automatic grid-off: ${requester.reason}`,
    situation.nowMs
  );
  context.lastSwitchAtMs = situation.nowMs;
  context.setRequested({ model: NORMAL_HYBRID_MODEL, atMs: situation.nowMs });
  recordEvent(
    context,
    requester.by === "page" ? "050 requested from the page" : `050 requested automatically: ${requester.reason}`
  );
  return untrack(context.readback)?.model === NORMAL_HYBRID_MODEL
    ? "The inverter already reads 050: nothing to send"
    : "DM050 queued: the DM readback confirms it in ~10–15 s";
}

/** Why a request for 151 would be refused right now, untracked; undefined = it would go out */
export function currentOffGridRefusal(context: GridOffContext): string | undefined {
  return untrack(() => switchOffGridRefusal(currentSituation(context), context.settings()));
}

/** Runs on every request/readback/SOC/config change and every guard tick; every read is untracked */
export function evaluateGuards(context: GridOffContext): void {
  const requested = untrack(context.requested);
  const situation = untrack(() => currentSituation(context));
  const settings = untrack(context.settings);
  if (requested.model === OFF_GRID_III_MODEL) {
    const revert = revertCause(situation, settings, requested.atMs ?? situation.nowMs);
    if (revert) {
      guardSwitchBack(context, revert, situation, settings);
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
    // A switch like any other: the startup fail-safe's 050 spaces the next 151 by min_seconds_between_switches
    context.lastSwitchAtMs = situation.nowMs;
  }
}

/**
 * The guard's switch back. The routine reconnect before a window, while automatic grid-off is on, goes out as
 * its request, in its words (the same reason it shows): whichever 10 s timer gets there first, the guard's or
 * automatic grid-off's, the log and the card say it the same way
 */
function guardSwitchBack(
  context: GridOffContext,
  revert: RevertCause,
  situation: GridOffSituation,
  settings: GridOffConfig
): void {
  if (revert.kind === "window" && revert.window && settings.auto_enabled) {
    const reason = describeWindowConflict(revert.window, situation.nowMs, settings);
    requestNormal(context, { by: "auto", reason }, "routine");
    return;
  }
  warnLog(`Grid off: guard switching back to 050 — ${revert.reason};`, describeSituation(situation));
  settleOffGridFailures(context, FAILED_SWITCH_REVERT_KINDS.has(revert.kind) ? "failed" : "routine", situation.nowMs);
  queueSwitchBack(context, revert.reason, situation.nowMs);
  context.lastSwitchAtMs = situation.nowMs;
  // The flip re-runs the guards at once; their follow-up only logs (followingUpRequest)
  context.setRequested({ model: NORMAL_HYBRID_MODEL, atMs: situation.nowMs });
  recordEvent(context, `Guard switched back to 050: ${revert.reason}`);
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
      episodeOnsetMs: next.conditionSinceMs ?? situation.nowMs,
      stuckForMs,
      switchBackSends: context.switchBackSends.count,
      why: context.lastReconciliationReason ?? "a switch back to 050",
    });
  } else if (previous.stuck && !next.stuck && previous.conditionSinceMs !== undefined) {
    logLog("Grid off: no longer stuck — the inverter reads", describeMachineModel(situation.readbackModel));
    recordEvent(context, "No longer stuck on 151");
    raiseStuckOffGridResolved(context.raise, {
      episodeOnsetMs: previous.conditionSinceMs,
      stuckForMs: situation.nowMs - previous.conditionSinceMs,
    });
  }
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
  settleOffGridFailures(context, "failed", nowMs);
  context.lastSwitchAtMs = nowMs;
  context.setRequested({ model: NORMAL_HYBRID_MODEL, atMs: nowMs });
  recordEvent(context, "DM151 rejected by the inverter (NAK): back to 050");
}

/**
 * The failed-switch count automatic grid-off backs off on (autoGridOffDecisions.ts): a 151 that didn't hold adds
 * one, a routine switch back clears it. Not cleared when a 151 applies: a link that drops every few minutes
 * lets each one apply first, and only counting on across them spaces the retries 5, 15, then 60 min.
 */
function settleOffGridFailures(context: GridOffContext, outcome: SwitchBackOutcome, nowMs: number): void {
  if (outcome === "failed") {
    context.offGridFailures = { count: context.offGridFailures.count + 1, lastAtMs: nowMs };
    return;
  }
  if (context.offGridFailures.count === 0) return;
  logLog(
    `Grid off: a routine switch back clears the retry back-off after ${context.offGridFailures.count} switch(es) to 151 that didn't hold`
  );
  context.offGridFailures = NO_OFF_GRID_FAILURES;
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

/** The reason of an automatic request is in automatic grid-off's own log line and its status */
function describeRequester(requester: SwitchRequester): string {
  return requester.by === "page" ? "from the page" : "automatically";
}
