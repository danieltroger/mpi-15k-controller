/**
 * Automatic grid-off's live wiring (grid_off.auto_enabled): the desired machine model is derived from the
 * config, the SOC, the schedule, the switch and the energy-distribution enforcement (autoGridOffDecisions.ts),
 * on every change of those and every AUTO_TICK_INTERVAL_MS, and the grid-off switch is asked for it through
 * the same request path as the page's buttons (gridOffActions.ts), so every precondition and guard stands as
 * it does for them. Each change of what it wants is logged once, with the reason. Off, it judges nothing and
 * asks for nothing; turning it off while it has the grid off asks for 050 once.
 */
import { type Accessor, createEffect, createMemo, createSignal, onCleanup, type Setter, untrack } from "solid-js";
import type { Config, GridOffConfig } from "../config/config.types.ts";
import type { EnergyDistributionStatus } from "../energyDistribution/energyDistribution.types.ts";
import { useBatteryValuesProvider } from "../battery/BatteryValuesProvider.ts";
import { NORMAL_HYBRID_MODEL, OFF_GRID_III_MODEL } from "../inverterComms/machineModel.ts";
import { errorLog, logLog } from "../utilities/logging.ts";
import { correctedGridOffSettings } from "./gridOffContext.ts";
import { scheduledWindows } from "./gridOffDecisions.ts";
import {
  type AutoGridOffDecision,
  type AutoGridOffSituation,
  autoGridOffDecision,
  autoRetryBlockedUntilMs,
  expectedNextSwitch,
} from "./autoGridOffDecisions.ts";
import type { AutoGridOffNextSwitch, AutoGridOffStatus } from "./gridOff.types.ts";
import type { GridOffSwitch } from "./useGridOffSwitch.ts";

/** How often the time-based rules (a window coming within the lead, the retry back-off) are re-judged */
const AUTO_TICK_INTERVAL_MS = 10_000;

export function useAutoGridOff({
  config,
  gridOffSwitch,
  energyDistributionStatus,
}: Pick<AutoGridOffEnvironment, "config" | "gridOffSwitch" | "energyDistributionStatus">) {
  const { clampedSocAh } = useBatteryValuesProvider();
  return createAutoGridOff({
    config,
    soc: clampedSocAh,
    gridOffSwitch,
    energyDistributionStatus,
    wallClockNowMs: () => Date.now(),
  });
}

/** Everything automatic grid-off reads and asks for, as plain accessors so a selftest can build the graph */
export type AutoGridOffEnvironment = {
  config: Accessor<Config>;
  /** THE SOC (clampedSocAh) */
  soc: Accessor<number | undefined>;
  gridOffSwitch: Pick<
    GridOffSwitch,
    | "requestedMachineModel"
    | "status"
    | "offGridRefusal"
    | "offGridFailures"
    | "switchOffGridAutomatically"
    | "switchBackAutomatically"
  >;
  energyDistributionStatus: Accessor<EnergyDistributionStatus | undefined>;
  /** Date.now() in production */
  wallClockNowMs: () => number;
};

export function createAutoGridOff(environment: AutoGridOffEnvironment) {
  const settings = createMemo(() => correctedGridOffSettings(environment.config().grid_off));
  const [decision, setDecision] = createSignal<AutoGridOffDecision | undefined>(undefined, {
    equals: (previous, next) =>
      previous?.model === next?.model && previous?.kind === next?.kind && previous?.reason === next?.reason,
  });
  const [nextSwitch, setNextSwitch] = createSignal<AutoGridOffNextSwitch | undefined>(undefined, {
    equals: (previous, next) =>
      previous?.model === next?.model && previous?.at === next?.at && previous?.why === next?.why,
  });
  const context: AutoGridOffContext = {
    ...environment,
    settings,
    setDecision,
    setNextSwitch,
    lastLogged: undefined,
  };

  // Before the evaluation below: on the update that turns it off, the hand-back goes out first
  createEffect<boolean | undefined>(wasEnabled => {
    const enabled = settings().auto_enabled;
    if (wasEnabled === true && !enabled) untrack(() => handBackOnDisable(context));
    return enabled;
  });
  // Reactive on what can change the answer at once (a SOC update, a window written, a readback, the
  // enforcement converging); the tick covers the passing of time
  createEffect(() => {
    settings();
    environment.config();
    environment.soc();
    environment.gridOffSwitch.status();
    environment.energyDistributionStatus();
    untrack(() => evaluateAutoGridOff(context));
  });
  const tickTimer = setInterval(() => {
    // A throw out of a timer callback is an uncaught exception, i.e. a controller restart
    try {
      evaluateAutoGridOff(context);
    } catch (error) {
      errorLog("Auto grid-off: evaluating the rules failed, retrying next tick", error);
    }
  }, AUTO_TICK_INTERVAL_MS);
  onCleanup(() => clearInterval(tickTimer));

  const status = createMemo<AutoGridOffStatus>(() => ({
    enabled: settings().auto_enabled,
    desired_model: decision()?.model,
    reason_kind: decision()?.kind,
    reason: decision()?.reason,
    next_switch: nextSwitch(),
    settings: settings(),
  }));
  return { status };
}

type AutoGridOffContext = AutoGridOffEnvironment & {
  settings: Accessor<GridOffConfig>;
  setDecision: Setter<AutoGridOffDecision | undefined>;
  setNextSwitch: Setter<AutoGridOffNextSwitch | undefined>;
  /** The model and reason kind last logged: each change of what it wants logs once */
  lastLogged: Pick<AutoGridOffDecision, "model" | "kind"> | undefined;
};

/** Runs on every change of its inputs and every tick; every read is untracked */
function evaluateAutoGridOff(context: AutoGridOffContext): void {
  const settings = untrack(context.settings);
  if (!settings.auto_enabled) {
    context.setDecision(undefined);
    context.setNextSwitch(undefined);
    context.lastLogged = undefined;
    return;
  }
  const { gridOffSwitch } = context;
  const nowMs = context.wallClockNowMs();
  const config = untrack(context.config);
  const offGridRequested = untrack(gridOffSwitch.requestedMachineModel) === OFF_GRID_III_MODEL;
  const situation: AutoGridOffSituation = {
    nowMs,
    soc: untrack(context.soc),
    offGridRequested,
    windows: scheduledWindows(config.scheduled_power_selling.schedule, config.scheduled_power_buying.schedule, nowMs),
    // Only switching off is judged on it; off the grid the switch's own guards stand
    switchRefusal: offGridRequested ? undefined : gridOffSwitch.offGridRefusal(),
    energySettingsRestoring: energySettingsRestoring(untrack(context.energyDistributionStatus)),
    retryBlockedUntilMs: autoRetryBlockedUntilMs(gridOffSwitch.offGridFailures()),
  };
  const decision = autoGridOffDecision(situation, settings);
  context.setDecision(decision);
  context.setNextSwitch(expectedNextSwitch(decision, situation, settings));
  logChange(context, decision);
  if (decision.model === OFF_GRID_III_MODEL && !offGridRequested) {
    askSwitch(() => gridOffSwitch.switchOffGridAutomatically(decision.reason), "DM151");
  } else if (decision.model === NORMAL_HYBRID_MODEL && offGridRequested) {
    // An unknown SOC means the 151 didn't hold (the guard counts it the same when it is first); the rest are routine
    const outcome = decision.kind === "soc_unknown" ? "failed" : "routine";
    askSwitch(() => gridOffSwitch.switchBackAutomatically(decision.reason, outcome), "DM050");
  }
}

/** Turned off with the grid off: the 151 is automatic grid-off's own (the page's buttons were refused), so 050 */
function handBackOnDisable(context: AutoGridOffContext): void {
  if (context.gridOffSwitch.requestedMachineModel() !== OFF_GRID_III_MODEL) {
    logLog("Auto grid-off: turned off (grid_off.auto_enabled false); the inverter is on the grid already");
    return;
  }
  logLog("Auto grid-off: turned off (grid_off.auto_enabled false) with the grid off — back to normal (050)");
  askSwitch(
    () => context.gridOffSwitch.switchBackAutomatically("automatic grid-off was turned off", "routine"),
    "DM050"
  );
}

/**
 * The enforcement is writing the 050 profile back (an open divergence episode while 050 is in force): a DM
 * change resets HECS, and switching to 151 before the restore lands would reset it again over the writes. A
 * managed field missing from the HECS answer (unread_fields) doesn't count: it is never written, so nothing
 * is in flight to compound, and on a firmware that never answers it waiting would keep the grid on for good.
 */
function energySettingsRestoring(status: EnergyDistributionStatus | undefined): boolean {
  return status?.profile_name === "normal_hybrid" && status.divergence !== undefined;
}

function logChange(context: AutoGridOffContext, decision: AutoGridOffDecision): void {
  const last = context.lastLogged;
  if (last?.model === decision.model && last.kind === decision.kind) return;
  context.lastLogged = { model: decision.model, kind: decision.kind };
  logLog(
    decision.model === OFF_GRID_III_MODEL
      ? `Auto grid-off: wants 151 (off the grid) — ${decision.reason}`
      : `Auto grid-off: wants 050 (on the grid) — ${decision.reason}`
  );
}

/** The switch was judged willing just before, so a refusal thrown back is a bug: loud, and retried next tick */
function askSwitch(request: () => void, command: string): void {
  try {
    request();
  } catch (error) {
    errorLog(`Auto grid-off: the switch refused ${command} it was judged willing to send`, error);
  }
}
