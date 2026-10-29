/**
 * Self-test of the bounded automatic_trading knobs (plannerKnobBounds.ts): an in-bounds value passes, one
 * outside is clamped, a non-number falls back to the default, and the config default sits inside the
 * bounds. Run from backend/ with:
 *   yarn node src/autoTrading/plannerKnobBounds.selftest.ts
 */
import { default_config } from "../config/config.ts";
import { type BoundedPlannerKnobName, effectivePlannerKnob, PLANNER_KNOB_BOUNDS } from "./plannerKnobBounds.ts";
import { check, finishSelftest } from "./plannerSelftestFixtures.ts";

const CASES: { knobName: BoundedPlannerKnobName; inBounds: number; tooLow: number; tooHigh: number }[] = [
  { knobName: "min_sell_power_watts", inBounds: 2000, tooLow: 300, tooHigh: 20000 },
  { knobName: "fragmentation_tolerance_sek_per_window", inBounds: 0.35, tooLow: -0.5, tooHigh: 5 },
];

for (const { knobName, inBounds, tooLow, tooHigh } of CASES) {
  const { defaultValue, min, max } = PLANNER_KNOB_BOUNDS[knobName];
  const passed = effectivePlannerKnob(knobName, inBounds);
  check(`${knobName}: an in-bounds value passes unchanged`, passed.value === inBounds && !passed.correction);
  // A negative value isn't a plausible setting at all (both knobs are ≥ 0), so it gets the default
  const lowered = effectivePlannerKnob(knobName, tooLow);
  const expectedForTooLow = tooLow < 0 ? defaultValue : min;
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

finishSelftest();
