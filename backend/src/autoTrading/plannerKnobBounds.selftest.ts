/**
 * Self-test of the bounded automatic_trading knobs (plannerKnobBounds.ts): an in-bounds value passes, one
 * outside is clamped, a non-number falls back to the default, and the config default sits inside the
 * bounds. Run from backend/ with:
 *   yarn node src/autoTrading/plannerKnobBounds.selftest.ts
 */
import { default_config } from "../config/config.ts";
import {
  type BoundedPlannerKnobName,
  effectivePlannerKnob,
  HOLD_CLASS_MAX_WATTS,
  PLANNER_KNOB_BOUNDS,
} from "./plannerKnobBounds.ts";
import { effectiveHoldEnabled, plannerKnobsFromConfig } from "./plannerKnobs.ts";
import { check, finishSelftest } from "./plannerSelftestFixtures.ts";

const CASES: { knobName: BoundedPlannerKnobName; inBounds: number; tooLow: number; tooHigh: number }[] = [
  { knobName: "min_sell_power_watts", inBounds: 2000, tooLow: 300, tooHigh: 20000 },
  { knobName: "fragmentation_tolerance_sek_per_window", inBounds: 0.35, tooLow: -0.5, tooHigh: 5 },
  { knobName: "terminal_value_scale", inBounds: 1.0, tooLow: -0.2, tooHigh: 2 },
  { knobName: "terminal_value_trailing_days", inBounds: 14, tooLow: 0, tooHigh: 90 },
  { knobName: "terminal_value_min_saving_sek_per_kwh", inBounds: 0.25, tooLow: -0.1, tooHigh: 3 },
  { knobName: "terminal_value_forecast_max_deviation_sek", inBounds: 0.5, tooLow: -0.25, tooHigh: 10 },
  { knobName: "terminal_value_forecast_max_age_hours", inBounds: 3, tooLow: 0, tooHigh: 48 },
  { knobName: "terminal_value_forecast_wait_seconds", inBounds: 60, tooLow: 1, tooHigh: 600 },
  { knobName: "hold_power_watts", inBounds: 200, tooLow: 20, tooHigh: 5000 },
  { knobName: "hold_overhead_watts", inBounds: 150, tooLow: -50, tooHigh: 2000 },
  // The one knob that may be negative (the battery still giving a little during a hold): clamped, not reset
  { knobName: "hold_net_dc_in_watts", inBounds: -50, tooLow: -500, tooHigh: 1000 },
  { knobName: "hold_margin_sek_per_kwh", inBounds: 0.2, tooLow: -0.1, tooHigh: 1.5 },
  { knobName: "hold_min_window_minutes", inBounds: 60, tooLow: 5, tooHigh: 600 },
  { knobName: "hold_bridge_minutes", inBounds: 45, tooLow: -15, tooHigh: 240 },
  { knobName: "hold_grid_margin_amps", inBounds: 3, tooLow: -1, tooHigh: 16 },
  { knobName: "hold_reentry_minutes", inBounds: 30, tooLow: 0.5, tooHigh: 600 },
  { knobName: "hold_reentry_hysteresis_amps", inBounds: 1, tooLow: 0.2, tooHigh: 10 },
  { knobName: "hold_min_battery_temp_celsius", inBounds: 8, tooLow: -5, tooHigh: 40 },
];

for (const { knobName, inBounds, tooLow, tooHigh } of CASES) {
  const { defaultValue, min, max } = PLANNER_KNOB_BOUNDS[knobName];
  const passed = effectivePlannerKnob(knobName, inBounds);
  check(`${knobName}: an in-bounds value passes unchanged`, passed.value === inBounds && !passed.correction);
  // A negative value isn't a plausible setting for a knob whose minimum isn't, so it gets the default
  const lowered = effectivePlannerKnob(knobName, tooLow);
  const expectedForTooLow = tooLow < 0 && min >= 0 ? defaultValue : min;
  check(
    `${knobName}: below the minimum is corrected`,
    lowered.value === expectedForTooLow && !!lowered.correction,
    `(${lowered.correction})`
  );
  const raised = effectivePlannerKnob(knobName, tooHigh);
  check(
    `${knobName}: above the maximum is lowered to it`,
    raised.value === max && !!raised.correction,
    `(${raised.correction})`
  );
  const notANumber = effectivePlannerKnob(knobName, String(inBounds));
  check(
    `${knobName}: a non-number falls back to the default`,
    notANumber.value === defaultValue && !!notANumber.correction,
    `(${notANumber.correction})`
  );
  check(
    `${knobName}: the config default is the bounds' default`,
    default_config.automatic_trading[knobName] === defaultValue && defaultValue >= min && defaultValue <= max
  );
}

// hold_enabled: only a boolean counts, anything else is off with a warning
check(
  "hold_enabled: true and false pass unchanged",
  effectiveHoldEnabled(true).value === true &&
    !effectiveHoldEnabled(true).correction &&
    effectiveHoldEnabled(false).value === false &&
    !effectiveHoldEnabled(false).correction
);
for (const notABoolean of ["true", 1, undefined, null]) {
  const corrected = effectiveHoldEnabled(notABoolean);
  check(
    `hold_enabled: ${JSON.stringify(notABoolean)} is off, with a correction`,
    corrected.value === false && !!corrected.correction,
    `(${corrected.correction})`
  );
}
check("hold_enabled ships off", default_config.automatic_trading.hold_enabled === false);
check(
  "every hold window counts as a hold at runtime, and the class is 300 W, not whatever the knob's maximum is",
  HOLD_CLASS_MAX_WATTS === 300 && PLANNER_KNOB_BOUNDS.hold_power_watts.max === HOLD_CLASS_MAX_WATTS
);
const knobs = plannerKnobsFromConfig({
  ...default_config,
  automatic_trading: { ...default_config.automatic_trading, hold_power_watts: 5000, hold_bridge_minutes: -15 },
});
check(
  "plannerKnobsFromConfig hands the planner the clamped hold knobs",
  knobs.hold_power_watts === 300 && knobs.hold_bridge_minutes === PLANNER_KNOB_BOUNDS.hold_bridge_minutes.defaultValue,
  `(${knobs.hold_power_watts} W, ${knobs.hold_bridge_minutes} min)`
);

finishSelftest();
