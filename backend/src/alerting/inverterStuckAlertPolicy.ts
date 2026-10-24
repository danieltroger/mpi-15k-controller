import type { AlertingConfig } from "../config/config.types.ts";
import type { InverterStuckRuleId, RuleEvaluation } from "./inverterStuckDetection.ts";
import { inverterStuckRuleIds } from "./inverterStuckDetection.ts";
import {
  advanceSustainedCondition,
  INACTIVE_SUSTAINED_CONDITION,
  type SustainedConditionState,
} from "./sustainedCondition.ts";

/**
 * The three signatures describe one failure (replaying 2026-10-21 they activate ~30 min, ~50 min
 * and ~2.5 h after the latch), so they share ONE alert: a P2 when the first one has held long enough,
 * nothing more as the others join, an optional P1 if it's still stuck later, and a quiet P3 once
 * every signature has seen power flowing again. Pure: the wiring in inverterStuckAlerts.ts owns
 * the clock and the manager.
 */
export function stepInverterStuckAlert(
  previous: InverterStuckAlertState,
  evaluations: Record<InverterStuckRuleId, RuleEvaluation>,
  nowMs: number,
  settings: InverterStuckSettings
): { state: InverterStuckAlertState; action: InverterStuckAlertAction | undefined } {
  const rules = advanceRuleStates(previous.rules, evaluations, nowMs, settings);
  const activeOnsets = inverterStuckRuleIds
    .map(ruleId => rules[ruleId])
    .filter(rule => rule.active)
    .map(rule => rule.onsetMs ?? nowMs);

  if (activeOnsets.length && previous.raisedAtMs === undefined) {
    return {
      state: { rules, raisedAtMs: nowMs, onsetMs: Math.min(...activeOnsets), escalated: false },
      action: "raise_p2",
    };
  }
  if (activeOnsets.length && previous.raisedAtMs !== undefined) {
    const escalates =
      !previous.escalated &&
      settings.inverter_stuck_p1_after_minutes > 0 &&
      nowMs - previous.raisedAtMs >= settings.inverter_stuck_p1_after_minutes * 60_000;
    return {
      state: { ...previous, rules, escalated: previous.escalated || escalates },
      action: escalates ? "escalate_p1" : undefined,
    };
  }
  if (previous.raisedAtMs !== undefined) {
    return { state: { ...INVERTER_STUCK_IDLE_STATE, rules }, action: "resolve" };
  }
  return { state: { ...previous, rules }, action: undefined };
}

export type InverterStuckSettings = Pick<
  AlertingConfig,
  "inverter_stuck_sustain_minutes" | "inverter_stuck_buy_window_sustain_minutes" | "inverter_stuck_p1_after_minutes"
>;

export type InverterStuckAlertState = {
  rules: Record<InverterStuckRuleId, SustainedConditionState>;
  /** When the P2 went out; undefined while not alerting */
  raisedAtMs: number | undefined;
  /** Earliest onset among the signatures active when the P2 went out */
  onsetMs: number | undefined;
  escalated: boolean;
};

export type InverterStuckAlertAction = "raise_p2" | "escalate_p1" | "resolve";

export const INVERTER_STUCK_IDLE_STATE: InverterStuckAlertState = {
  rules: {
    dc_side_idle: INACTIVE_SUSTAINED_CONDITION,
    pv_stalled_in_daylight: INACTIVE_SUSTAINED_CONDITION,
    buy_window_not_charging: INACTIVE_SUSTAINED_CONDITION,
  },
  raisedAtMs: undefined,
  onsetMs: undefined,
  escalated: false,
};

/**
 * Resolving needs this long of positive evidence, so one plausible frame in the middle of a
 * latch can't send "resolved" followed by a fresh P2 half an hour later.
 */
export const INVERTER_STUCK_CLEAR_AFTER_MS = 5 * 60_000;

export const INVERTER_STUCK_RULE_LABELS: Record<InverterStuckRuleId, string> = {
  dc_side_idle: "DC side idle",
  pv_stalled_in_daylight: "PV stalled in daylight",
  buy_window_not_charging: "buy window not charging",
};

// PI17 has no reset command and LON0 would cut the pi's own power, so a human has to do this
const POWER_CYCLE_ADVICE = "Check the LCD fault code, then power-cycle the inverter (off, wait ~1 min, on).";

/** Title + message for a P2/P1, leading with the signature that started first. */
export function describeInverterStuckAlert(
  state: InverterStuckAlertState,
  evaluations: Record<InverterStuckRuleId, RuleEvaluation>,
  nowMs: number,
  severity: "P2" | "P1"
): { title: string; message: string } {
  const activeRuleIds = inverterStuckRuleIds
    .filter(ruleId => state.rules[ruleId].active)
    .sort((first, second) => (state.rules[first].onsetMs ?? nowMs) - (state.rules[second].onsetMs ?? nowMs));
  const [leadRuleId, ...otherRuleIds] = activeRuleIds;
  if (!leadRuleId) {
    return { title: "Inverter stuck", message: `Inverter looked stuck. ${POWER_CYCLE_ADVICE}` };
  }
  const since = formatStockholmTime(state.rules[leadRuleId].onsetMs ?? nowMs, nowMs);
  const alsoSeen = otherRuleIds.map(
    ruleId =>
      `${INVERTER_STUCK_RULE_LABELS[ruleId]} since ${formatStockholmTime(state.rules[ruleId].onsetMs ?? nowMs, nowMs)}`
  );
  const stillStuckPrefix =
    severity === "P1" && state.raisedAtMs !== undefined
      ? `Still stuck ${Math.round((nowMs - state.raisedAtMs) / 60_000)} min after the first alert. `
      : "";
  return {
    title: `Inverter ${severity === "P1" ? "STILL " : ""}stuck: ${INVERTER_STUCK_RULE_LABELS[leadRuleId]}`,
    message:
      stillStuckPrefix +
      `${leadSentence(leadRuleId, since)} ${POWER_CYCLE_ADVICE}` +
      (alsoSeen.length ? ` Also: ${alsoSeen.join("; ")}.` : "") +
      ` Now: ${evaluations[leadRuleId].detail}.`,
  };
}

export function describeInverterStuckResolved(onsetMs: number | undefined, nowMs: number): string {
  const range = onsetMs === undefined ? "" : ` (stuck since ${formatStockholmTime(onsetMs, nowMs)}, local time)`;
  return `Power is flowing through the inverter's DC side again${range}.`;
}

/** HH:MM in Europe/Stockholm, with the date when it isn't today there. */
export function formatStockholmTime(atMs: number, nowMs: number): string {
  const timeZone = "Europe/Stockholm";
  const clock = new Date(atMs).toLocaleTimeString("sv-SE", { timeZone, hour: "2-digit", minute: "2-digit" });
  const day = new Date(atMs).toLocaleDateString("sv-SE", { timeZone });
  return day === new Date(nowMs).toLocaleDateString("sv-SE", { timeZone }) ? clock : `${day} ${clock}`;
}

function leadSentence(ruleId: InverterStuckRuleId, since: string): string {
  if (ruleId === "dc_side_idle") {
    return `Inverter DC side idle since ${since} (local time): battery and PV unused, house on grid with no backup.`;
  }
  if (ruleId === "pv_stalled_in_daylight") {
    return `Inverter PV input stalled since ${since} (local time): the panels have voltage but both MPPTs sit idle at 0 W in daylight.`;
  }
  return `Inverter ignoring a grid-charge window since ${since} (local time): it confirmed the charge but the battery takes nothing.`;
}

/** A commanded charge shows up within a minute, so Rule C can afford a much shorter fuse. */
export function sustainMinutesForRule(ruleId: InverterStuckRuleId, settings: InverterStuckSettings): number {
  return ruleId === "buy_window_not_charging"
    ? settings.inverter_stuck_buy_window_sustain_minutes
    : settings.inverter_stuck_sustain_minutes;
}

function advanceRuleStates(
  previousRules: Record<InverterStuckRuleId, SustainedConditionState>,
  evaluations: Record<InverterStuckRuleId, RuleEvaluation>,
  nowMs: number,
  settings: InverterStuckSettings
): Record<InverterStuckRuleId, SustainedConditionState> {
  return {
    dc_side_idle: advanceRuleState("dc_side_idle", previousRules, evaluations, nowMs, settings),
    pv_stalled_in_daylight: advanceRuleState("pv_stalled_in_daylight", previousRules, evaluations, nowMs, settings),
    buy_window_not_charging: advanceRuleState("buy_window_not_charging", previousRules, evaluations, nowMs, settings),
  };
}

function advanceRuleState(
  ruleId: InverterStuckRuleId,
  previousRules: Record<InverterStuckRuleId, SustainedConditionState>,
  evaluations: Record<InverterStuckRuleId, RuleEvaluation>,
  nowMs: number,
  settings: InverterStuckSettings
): SustainedConditionState {
  return advanceSustainedCondition(previousRules[ruleId], evaluations[ruleId].observation, nowMs, {
    activateAfterMs: sustainMinutesForRule(ruleId, settings) * 60_000,
    clearAfterMs: INVERTER_STUCK_CLEAR_AFTER_MS,
  });
}
