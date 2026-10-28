/**
 * The write throttle for the inverter's analog setter targets: the AC charging current (MUCHGC) and the
 * feed-in limit (GPMP). Pure (type-only imports): the config page shares the bounds, and the reactive
 * wiring is throttledSetterTarget.ts.
 *
 * Why: the mpp-solar path spaced all commands ≥ 40 s apart, and the native engine (#48) sends every
 * change as it comes. In the 2026-10-27 buy window (18:45–22:00 UTC), the charging current target chased
 * 1–2 A of per-phase load noise, and MUCHGC went out 545 times, a median 14 s apart (323 of them were
 * 1 A moves). The inverter dropped off the grid with "AC input island" 5 times, each one showing up in
 * the first poll after a MUCHGC write's 12 s quiet gap, i.e. while that write was committing. Earlier
 * that evening, GPMP went out every ~25 s on the anti-peak bumps.
 *
 * The rules, per setter:
 * - A new target goes out at most once per min_seconds_between_setting_changes.
 * - The first target after a start goes out at once. So does a mode change (a buy window starting or
 *   ending, feeding switching between solar-only, battery and selling), because that switches a function
 *   on or off, and the window end is the step-down's 10 A cap (#63).
 * - An AC charging current at least ac_charging_current_immediate_decrease_amps below the last one goes
 *   out at once, so a load that would overload a phase (the EV starting mid-window) never waits. A
 *   smaller decrease waits like an increase: on the noise, letting every decrease through would keep
 *   the writes coming every few seconds.
 * The on/off switches (EDB/EDF/EDG), the step-down's own re-asks and alternate cap, and MCHGV (which has
 * its own 60 s spacing) don't pass through here at all.
 */
import type { Config } from "../config/config.types.ts";

export type SetterChangeThrottleSettingName =
  | "min_seconds_between_setting_changes"
  | "ac_charging_current_immediate_decrease_amps";

export type SetterChangeThrottleSettings = Pick<Config["usb_parameter_setting"], SetterChangeThrottleSettingName>;

export type SetterChangeThrottleBounds = { defaultValue: number; min: number; max: number; unit: "s" | "A" };

export const SETTER_CHANGE_THROTTLE_BOUNDS = {
  // 45 s is about three of the 2026-10-27 write cadences, and well past the inverter's ~7–11 s commit.
  // Past 5 min, an increase (more headroom on the fuse, a bigger anti-peak bump) waits too long to be
  // worth making. At least 15 s, past a commit plus one 4 s re-read: a target blip any shorter can land
  // and be overwritten between two readbacks, an A→B→A the starved-write page (schedulerTiming.ts) takes
  // for a field that never moved, and whose unseen B the drop-trust chain may credit before its 60 s
  // mark (#75's delta review: about one false P2 an hour at the cap with no throttle).
  min_seconds_between_setting_changes: { defaultValue: 45, min: 15, max: 300, unit: "s" },
  // Battery amps, which the three-phase charger draws evenly from all phases: at the top of a charge
  // (57.6 V, ~93 % charger efficiency) 10 A is ~0.9 A at 230 V per phase. The held limit always stays
  // less than this margin above the wish (a decrease is measured against the target last let through, so
  // sub-margin steps can't add up), which bounds how far it can push the most-loaded phase past
  // max_grid_input_amperage. Each held decrease waits at most one interval, but holds can follow each
  // other while a load creeps up: replaying 2026-10-27, the overshoot peaked at 8 A and back-to-back
  // holds lasted up to 82 s. The noise (mostly 1–2 A moves, almost never over 6 A) stays below the
  // margin; a kettle (~110 A) or the EV is far above it. Capped at 30 A (~2.7 A per phase), so a held
  // decrease stays a small overshoot. 0 = every decrease at once.
  ac_charging_current_immediate_decrease_amps: { defaultValue: 10, min: 0, max: 30, unit: "A" },
} as const satisfies Record<SetterChangeThrottleSettingName, SetterChangeThrottleBounds>;

export const DEFAULT_SETTER_CHANGE_THROTTLE_SETTINGS: SetterChangeThrottleSettings = {
  min_seconds_between_setting_changes: SETTER_CHANGE_THROTTLE_BOUNDS.min_seconds_between_setting_changes.defaultValue,
  ac_charging_current_immediate_decrease_amps:
    SETTER_CHANGE_THROTTLE_BOUNDS.ac_charging_current_immediate_decrease_amps.defaultValue,
};

/** What the throttle last let through for one setter */
export type ThrottledSetterState<Mode extends string> = {
  /** What the consumer queues */
  target: number;
  mode: Mode;
  /** When the target last changed (monotonic ms) */
  changedAtMs: number;
};

/** The consumer's current wish: a target, and the mode it belongs to */
export type SetterTargetWish<Mode extends string> = { target: number; mode: Mode };

export type SetterThrottleLimits = {
  minIntervalMs: number;
  /** A decrease at least this large goes out at once; undefined: decreases wait like increases */
  immediateDecrease: number | undefined;
};

export type SetterChangeReason = "first_target" | "mode_change" | "large_decrease" | "interval_elapsed";

export type SetterTargetChange<Mode extends string> = {
  reason: SetterChangeReason;
  previous: ThrottledSetterState<Mode> | undefined;
  next: ThrottledSetterState<Mode>;
};

/**
 * One evaluation: the wish against what was last let through. `state` is `previous` itself (the same
 * object) when nothing changed, so a memo holding it doesn't notify.
 */
export function stepSetterThrottle<Mode extends string>(
  previous: ThrottledSetterState<Mode> | undefined,
  wish: SetterTargetWish<Mode>,
  limits: SetterThrottleLimits,
  nowMs: number
): { state: ThrottledSetterState<Mode>; change: SetterTargetChange<Mode> | undefined } {
  if (!previous) return changedTo(previous, wish, "first_target", nowMs);
  const modeChanged = wish.mode !== previous.mode;
  if (wish.target === previous.target) {
    // Only the mode moved (e.g. selling at the feed amount): nothing to write, and the interval keeps running
    return { state: modeChanged ? { ...previous, mode: wish.mode } : previous, change: undefined };
  }
  if (modeChanged) return changedTo(previous, wish, "mode_change", nowMs);
  const decrease = previous.target - wish.target;
  if (limits.immediateDecrease !== undefined && decrease > 0 && decrease >= limits.immediateDecrease) {
    return changedTo(previous, wish, "large_decrease", nowMs);
  }
  if (nowMs - previous.changedAtMs >= limits.minIntervalMs) return changedTo(previous, wish, "interval_elapsed", nowMs);
  return { state: previous, change: undefined };
}

export function acChargingCurrentThrottleLimits(settings: SetterChangeThrottleSettings): SetterThrottleLimits {
  return {
    minIntervalMs: settings.min_seconds_between_setting_changes * 1000,
    immediateDecrease: settings.ac_charging_current_immediate_decrease_amps,
  };
}

/** Interval only: a lower feed-in limit only sells less, and selling stopping is a mode change */
export function feedInLimitThrottleLimits(settings: SetterChangeThrottleSettings): SetterThrottleLimits {
  return { minIntervalMs: settings.min_seconds_between_setting_changes * 1000, immediateDecrease: undefined };
}

/**
 * A value that isn't a non-negative number falls back to the default; one outside the bounds is clamped
 * to them. Takes `unknown` because config.json is hand-editable.
 */
export function effectiveSetterChangeThrottleSetting(
  settingName: SetterChangeThrottleSettingName,
  configuredValue: unknown
): { value: number; correction: string | undefined } {
  const { defaultValue, min, max, unit } = SETTER_CHANGE_THROTTLE_BOUNDS[settingName];
  if (typeof configuredValue !== "number" || !Number.isFinite(configuredValue) || configuredValue < 0) {
    const shown = typeof configuredValue === "string" ? JSON.stringify(configuredValue) : String(configuredValue);
    return {
      value: defaultValue,
      correction: `${shown} is not a non-negative number, using the default ${defaultValue} ${unit}`,
    };
  }
  if (configuredValue < min) {
    return {
      value: min,
      correction: `${configuredValue} ${unit} is below the ${min} ${unit} minimum, using the minimum`,
    };
  }
  if (configuredValue > max) {
    return {
      value: max,
      correction: `${configuredValue} ${unit} exceeds the ${max} ${unit} maximum, using the maximum`,
    };
  }
  return { value: configuredValue, correction: undefined };
}

function changedTo<Mode extends string>(
  previous: ThrottledSetterState<Mode> | undefined,
  wish: SetterTargetWish<Mode>,
  reason: SetterChangeReason,
  nowMs: number
): { state: ThrottledSetterState<Mode>; change: SetterTargetChange<Mode> } {
  const next = { target: wish.target, mode: wish.mode, changedAtMs: nowMs };
  return { state: next, change: { reason, previous, next } };
}
