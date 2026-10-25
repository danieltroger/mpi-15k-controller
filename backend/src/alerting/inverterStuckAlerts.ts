import { type Accessor, createEffect, onCleanup, untrack } from "solid-js";
import type { Config } from "../config/config.types.ts";
import type { CurrentBatteryPowerBroadcast } from "../sharedTypes.ts";
import type { useFromMqttProvider } from "../mqttValues/MQTTValuesProvider.ts";
import type { AlertManager } from "./alertManager.ts";
import { sunElevationDegrees } from "../utilities/sunElevation.ts";
import { debugLog, errorLog, logLog, warnLog } from "../utilities/logging.ts";
import {
  evaluateInverterStuckRules,
  hallBlindWhileInverterTalks,
  type InverterStuckRuleId,
  inverterStuckRuleIds,
  type InverterStuckSnapshot,
  type RuleEvaluation,
} from "./inverterStuckDetection.ts";
import {
  describeInverterStuckAlert,
  describeInverterStuckResolved,
  type InverterStuckAlertAction,
  inverterStuckAlertKey,
  type InverterStuckAlertState,
  type InverterStuckSettings,
  INVERTER_STUCK_IDLE_STATE,
  INVERTER_STUCK_RULE_LABELS,
  persistableEpisode,
  restoreEpisode,
  stepInverterStuckAlert,
  sustainMinutesForRule,
} from "./inverterStuckAlertPolicy.ts";
import { loadOpenEpisode, saveOpenEpisode } from "./inverterStuckEpisodeStore.ts";
import {
  addTrailingSample,
  createTrailingMeanWindow,
  type TrailingMeanWindow,
  trailingMean,
} from "./sustainedCondition.ts";

/**
 * A 1-min mean keeps a single 4 Hz hall spike from breaking (or faking) a 30-min run. Not the SOC
 * ledger's useSmoothedCurrent: that memo smooths amps and isn't drivable from a selftest/backtest;
 * this one is pure, in watts, and prunes at read time.
 */
const HALL_SMOOTHING_WINDOW_MS = 60_000;
const EVALUATION_INTERVAL_MS = 15_000;
/** Long enough to skip the 60 s useCurrentMeasuring restart after an ADC error */
const HALL_BLIND_WARN_AFTER_MS = 10 * 60_000;

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

  let tickState: TickState = {
    alert: restoreEpisode(loadOpenEpisode()),
    hallBlindSinceMs: undefined,
    hallBlindWarned: false,
  };
  if (tickState.alert.raisedAtMs !== undefined) {
    logLog(
      "Inverter stuck: resuming the episode that was open before the restart",
      persistableEpisode(tickState.alert)
    );
  }
  const evaluationTimer = setInterval(() => {
    // A throw out of a timer callback is an uncaught exception, i.e. a controller restart
    try {
      tickState = evaluationTick(ctx, hallWindow, tickState);
      saveOpenEpisode(persistableEpisode(tickState.alert));
    } catch (error) {
      errorLog("Inverter-stuck alert evaluation failed, retrying next tick", error);
    }
  }, EVALUATION_INTERVAL_MS);
  onCleanup(() => clearInterval(evaluationTimer));
}

type TickState = {
  alert: InverterStuckAlertState;
  /** Start of the current streak without a fresh hall reading while the inverter talks */
  hallBlindSinceMs: number | undefined;
  hallBlindWarned: boolean;
};

function evaluationTick(
  ctx: Parameters<typeof startInverterStuckAlerts>[0],
  hallWindow: TrailingMeanWindow,
  previous: TickState
): TickState {
  const alerting = untrack(ctx.config).alerting;
  if (!alerting.inverter_stuck_p2) return { ...previous, alert: INVERTER_STUCK_IDLE_STATE };
  if (ctx.inGracePeriod()) return previous;
  const nowMs = Date.now();
  const snapshot = untrack(() => takeSnapshot(ctx, hallWindow, nowMs));
  const evaluations = evaluateInverterStuckRules(snapshot);
  const { state, action } = stepInverterStuckAlert(previous.alert, evaluations, nowMs, alerting);
  logRuleTransitions({ previousState: previous.alert, state, evaluations, nowMs, settings: alerting });
  if (action) {
    raiseForAction({ manager: ctx.manager, action, previousState: previous.alert, state, evaluations, nowMs });
  }
  return { alert: state, ...trackHallBlindness(previous, hallBlindWhileInverterTalks(snapshot), nowMs) };
}

/**
 * Without the hall, the DC-side-idle and buy-window checks can't run and only the daylight PV
 * check is left. Worth one log line per streak, not a push: the family shouldn't hear about a
 * sensor, and a dead ADC loop already errorLogs on its own.
 */
function trackHallBlindness(
  previous: Pick<TickState, "hallBlindSinceMs" | "hallBlindWarned">,
  hallBlind: boolean,
  nowMs: number
): Pick<TickState, "hallBlindSinceMs" | "hallBlindWarned"> {
  if (!hallBlind) {
    if (previous.hallBlindWarned) logLog("Inverter stuck: hall readings are back, all three checks run again");
    return { hallBlindSinceMs: undefined, hallBlindWarned: false };
  }
  const hallBlindSinceMs = previous.hallBlindSinceMs ?? nowMs;
  if (previous.hallBlindWarned || nowMs - hallBlindSinceMs < HALL_BLIND_WARN_AFTER_MS) {
    return { hallBlindSinceMs, hallBlindWarned: previous.hallBlindWarned };
  }
  warnLog(
    `Inverter stuck: no fresh hall sensor reading for ${Math.round((nowMs - hallBlindSinceMs) / 60_000)} min while ` +
      "the inverter is talking (current_measuring disabled or erroring?). The DC-side-idle and buy-window checks " +
      "can't run; only the daylight PV check is active."
  );
  return { hallBlindSinceMs, hallBlindWarned: true };
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
    void manager
      .raise({
        key: `${inverterStuckAlertKey(previousState)}:resolved`,
        severity: "P3",
        title: "Resolved: Inverter stuck",
        message: describeInverterStuckResolved(previousState.onsetMs, nowMs),
      })
      .catch(error => errorLog("Inverter stuck: raising the resolve notice failed", error));
    return;
  }
  const severity = action === "escalate_p1" ? "P1" : "P2";
  const key = inverterStuckAlertKey(state);
  void manager
    .raise({ key, severity, ...describeInverterStuckAlert(state, evaluations, nowMs, severity) })
    .then(record => {
      // The policy now believes the family knows; say so loudly in the log if they don't
      if (record.delivery === "cooldown" || record.delivery === "rate_capped") {
        warnLog(`Inverter stuck: the ${severity} on ${key} was not pushed (${record.delivery}): ${record.title}`);
      }
    })
    .catch(error => errorLog(`Inverter stuck: raising the ${severity} failed`, error));
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
