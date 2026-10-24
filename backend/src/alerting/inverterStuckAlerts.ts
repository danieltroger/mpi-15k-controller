import { type Accessor, createEffect, onCleanup, untrack } from "solid-js";
import type { Config } from "../config/config.types.ts";
import type { CurrentBatteryPowerBroadcast } from "../sharedTypes.ts";
import type { useFromMqttProvider } from "../mqttValues/MQTTValuesProvider.ts";
import type { AlertManager } from "./alertManager.ts";
import { sunElevationDegrees } from "../utilities/sunElevation.ts";
import { debugLog, errorLog, logLog } from "../utilities/logging.ts";
import {
  evaluateInverterStuckRules,
  type InverterStuckRuleId,
  inverterStuckRuleIds,
  type InverterStuckSnapshot,
  type RuleEvaluation,
} from "./inverterStuckDetection.ts";
import {
  describeInverterStuckAlert,
  describeInverterStuckResolved,
  type InverterStuckAlertAction,
  type InverterStuckAlertState,
  type InverterStuckSettings,
  INVERTER_STUCK_IDLE_STATE,
  INVERTER_STUCK_RULE_LABELS,
  stepInverterStuckAlert,
  sustainMinutesForRule,
} from "./inverterStuckAlertPolicy.ts";
import {
  addTrailingSample,
  createTrailingMeanWindow,
  type TrailingMeanWindow,
  trailingMean,
} from "./sustainedCondition.ts";

const ALERT_KEY = "inverter-stuck";
/** A 1-min mean keeps a single 4 Hz hall spike from breaking (or faking) a 30-min run */
const HALL_SMOOTHING_WINDOW_MS = 60_000;
const EVALUATION_INTERVAL_MS = 15_000;

/**
 * Live wiring for the stuck-inverter alert: feeds the hall into a trailing mean, snapshots the
 * signals every 15 s, and turns the pure policy's actions into manager raises. Everything that
 * decides anything lives in inverterStuckDetection.ts / inverterStuckAlertPolicy.ts.
 */
export function startInverterStuckAlerts(ctx: {
  config: Accessor<Config>;
  manager: AlertManager;
  mqttValues: ReturnType<typeof useFromMqttProvider>["mqttValues"];
  averageSOC: Accessor<number | undefined>;
  currentBatteryPower: Accessor<CurrentBatteryPowerBroadcast | undefined>;
  chargingAmperageForBuying: Accessor<number | undefined>;
  acChargingEnabledOnInverter: Accessor<boolean>;
  inGracePeriod: () => boolean;
}) {
  const hallWindow = createTrailingMeanWindow(HALL_SMOOTHING_WINDOW_MS);
  createEffect(() => {
    const reading = ctx.currentBatteryPower();
    if (reading) addTrailingSample(hallWindow, reading);
  });

  let alertState: InverterStuckAlertState = INVERTER_STUCK_IDLE_STATE;
  const evaluationTimer = setInterval(() => {
    // A throw out of a timer callback is an uncaught exception, i.e. a controller restart
    try {
      alertState = evaluationTick(ctx, hallWindow, alertState);
    } catch (e) {
      errorLog("Inverter-stuck alert evaluation failed, retrying next tick", e);
    }
  }, EVALUATION_INTERVAL_MS);
  onCleanup(() => clearInterval(evaluationTimer));
}

function evaluationTick(
  ctx: Parameters<typeof startInverterStuckAlerts>[0],
  hallWindow: TrailingMeanWindow,
  previousState: InverterStuckAlertState
): InverterStuckAlertState {
  const alerting = untrack(ctx.config).alerting;
  if (!alerting.inverter_stuck_p2) return INVERTER_STUCK_IDLE_STATE;
  if (ctx.inGracePeriod()) return previousState;
  const nowMs = Date.now();
  const evaluations = evaluateInverterStuckRules(untrack(() => takeSnapshot(ctx, hallWindow, nowMs)));
  const { state, action } = stepInverterStuckAlert(previousState, evaluations, nowMs, alerting);
  logRuleTransitions({ previousState, state, evaluations, nowMs, settings: alerting });
  if (action) raiseForAction({ manager: ctx.manager, action, previousState, state, evaluations, nowMs });
  return state;
}

function takeSnapshot(
  ctx: Parameters<typeof startInverterStuckAlerts>[0],
  hallWindow: TrailingMeanWindow,
  nowMs: number
): InverterStuckSnapshot {
  const { latitude, longitude } = ctx.config().automatic_trading;
  return {
    nowMs,
    // The store entries already are { value, time } per field; nothing writes them mid-tick
    inverter: ctx.mqttValues,
    smoothedHallWatts: trailingMean(hallWindow, nowMs),
    averageSOC: ctx.averageSOC(),
    sunElevationDegrees: sunElevationDegrees(nowMs, latitude, longitude),
    commandedChargingAmps: ctx.chargingAmperageForBuying(),
    acChargingEnabledOnInverter: ctx.acChargingEnabledOnInverter(),
  };
}

function raiseForAction(params: {
  manager: AlertManager;
  action: InverterStuckAlertAction;
  previousState: InverterStuckAlertState;
  state: InverterStuckAlertState;
  evaluations: Record<InverterStuckRuleId, RuleEvaluation>;
  nowMs: number;
}) {
  const { manager, action, previousState, state, evaluations, nowMs } = params;
  if (action === "resolve") {
    void manager.raise({
      key: `${ALERT_KEY}:resolved`,
      severity: "P3",
      title: "Resolved: Inverter stuck",
      message: describeInverterStuckResolved(previousState.onsetMs, nowMs),
    });
    return;
  }
  const severity = action === "escalate_p1" ? "P1" : "P2";
  // Same key for both, so the P1 escalation bypasses the P2's cooldown (decideSend ranks severities)
  void manager.raise({ key: ALERT_KEY, severity, ...describeInverterStuckAlert(state, evaluations, nowMs, severity) });
}

/** The log line per transition is what lets a near-miss (a run that ended before alerting) be found later. */
function logRuleTransitions(params: {
  previousState: InverterStuckAlertState;
  state: InverterStuckAlertState;
  evaluations: Record<InverterStuckRuleId, RuleEvaluation>;
  nowMs: number;
  settings: InverterStuckSettings;
}) {
  const { previousState, state, evaluations, nowMs, settings } = params;
  for (const ruleId of inverterStuckRuleIds) {
    const before = previousState.rules[ruleId];
    const after = state.rules[ruleId];
    const label = INVERTER_STUCK_RULE_LABELS[ruleId];
    const detail = evaluations[ruleId].detail;
    if (!before.active && after.active) {
      logLog(`Inverter stuck: "${label}" held for ${sustainMinutesForRule(ruleId, settings)} min — ${detail}`);
    } else if (before.active && !after.active) {
      logLog(`Inverter stuck: "${label}" cleared — ${detail}`);
    } else if (!after.active && before.failingSinceMs === undefined && after.failingSinceMs !== undefined) {
      debugLog(
        `Inverter stuck: "${label}" signature present, alerts if it holds ${sustainMinutesForRule(ruleId, settings)} min — ${detail}`
      );
    } else if (!after.active && before.failingSinceMs !== undefined && after.failingSinceMs === undefined) {
      const heldMinutes = Math.round((nowMs - before.failingSinceMs) / 60_000);
      debugLog(`Inverter stuck: "${label}" signature gone after ${heldMinutes} min, no alert — ${detail}`);
    }
  }
}
