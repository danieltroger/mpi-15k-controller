/**
 * The reactive side of setterChangeThrottle.ts: a setter's wished-for target as the throttle lets it
 * through, and the throttle's two config knobs as live, bounds-checked values.
 */
import { type Accessor, createEffect, createMemo, on } from "solid-js";
import type { Config } from "../config/config.types.ts";
import { logLog, warnLog } from "../utilities/logging.ts";
import {
  effectiveSetterChangeThrottleSetting,
  SETTER_CHANGE_THROTTLE_BOUNDS,
  type SetterChangeReason,
  type SetterChangeThrottleSettingName,
  type SetterChangeThrottleSettings,
  type SetterTargetChange,
  type SetterTargetWish,
  type SetterThrottleLimits,
  stepSetterThrottle,
  type ThrottledSetterState,
} from "./setterChangeThrottle.ts";

export type ThrottledSetterInput<Mode extends string> = {
  /** For the log: "MUCHGC", "GPMP" */
  setter: string;
  unit: string;
  /** Undefined while the consumer has no wish yet: the last target stays */
  wish: Accessor<SetterTargetWish<Mode> | undefined>;
  limits: Accessor<SetterThrottleLimits>;
  /** What entering each mode means, for the log ("buy window start") */
  modeChangeReasons: Record<Mode, string>;
  /** Re-evaluates the throttle, so a held target goes out within a tick of its interval passing */
  clockTick: Accessor<unknown>;
  monotonicNowMs: () => number;
};

/** What the consumer queues instead of its raw wish; every change is logged with its reason */
export function createThrottledSetterTarget<Mode extends string>(
  input: ThrottledSetterInput<Mode>
): Accessor<number | undefined> {
  const throttleState = createMemo<ThrottledSetterState<Mode> | undefined>(previous => {
    input.clockTick();
    const wish = input.wish();
    if (!wish) return previous;
    const limits = input.limits();
    const { state, change } = stepSetterThrottle(previous, wish, limits, input.monotonicNowMs());
    if (change) logSetterChange(input, limits, change);
    return state;
  }, undefined);
  return createMemo(() => throttleState()?.target);
}

/** The usb_parameter_setting throttle knobs, corrected to their bounds; a bad value warns once per value */
export function useSetterChangeThrottleSettings(getConfig: Accessor<Config>): Accessor<SetterChangeThrottleSettings> {
  const minSecondsBetweenChanges = useThrottleSetting(getConfig, "min_seconds_between_setting_changes");
  const immediateDecreaseAmps = useThrottleSetting(getConfig, "ac_charging_current_immediate_decrease_amps");
  return createMemo(() => ({
    min_seconds_between_setting_changes: minSecondsBetweenChanges(),
    ac_charging_current_immediate_decrease_amps: immediateDecreaseAmps(),
  }));
}

function logSetterChange<Mode extends string>(
  input: ThrottledSetterInput<Mode>,
  limits: SetterThrottleLimits,
  { reason, previous, next }: SetterTargetChange<Mode>
) {
  const sincePrevious = previous
    ? `, ${((next.changedAtMs - previous.changedAtMs) / 1000).toFixed(1)} s after the previous change`
    : "";
  logLog(
    `${input.setter} target ${previous ? previous.target : "(none)"} → ${next.target} ${input.unit}: ${describeChangeReason(input, limits, reason, next.mode)}${sincePrevious}`
  );
}

function describeChangeReason<Mode extends string>(
  input: ThrottledSetterInput<Mode>,
  limits: SetterThrottleLimits,
  reason: SetterChangeReason,
  enteredMode: Mode
): string {
  switch (reason) {
    case "first_target":
      return "first target since the controller started";
    case "mode_change":
      return input.modeChangeReasons[enteredMode];
    case "large_decrease":
      return `safety decrease (≥ ${limits.immediateDecrease} ${input.unit} below the last target, not held)`;
    case "interval_elapsed":
      return "throttled change";
  }
}

function useThrottleSetting(getConfig: Accessor<Config>, settingName: SetterChangeThrottleSettingName) {
  // The config signal changes as a whole: memoising the raw value first means a bad value warns once,
  // not on every unrelated config write
  const configuredValue = createMemo(() => getConfig().usb_parameter_setting[settingName]);
  const effectiveSetting = createMemo(() => effectiveSetterChangeThrottleSetting(settingName, configuredValue()));
  const value = createMemo(() => effectiveSetting().value);
  createEffect(() => {
    const { correction } = effectiveSetting();
    if (correction) warnLog(`usb_parameter_setting.${settingName}:`, correction);
  });
  createEffect(
    on(value, (currentValue, previousValue) => {
      if (previousValue === undefined) return;
      const { unit } = SETTER_CHANGE_THROTTLE_BOUNDS[settingName];
      logLog(`usb_parameter_setting.${settingName}: ${previousValue} → ${currentValue} ${unit}, applies at once`);
    })
  );
  return value;
}
