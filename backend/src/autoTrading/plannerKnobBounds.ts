/**
 * Bounds of the automatic_trading knobs the backend enforces before handing them to the planner, and the
 * correction of a value outside them (config.json is hand-editable; the config page's min/max are only input
 * hints). Pure (type-only imports): the config page shares the bounds.
 */
import type { AutomaticTradingConfig } from "../config/config.types.ts";

export type BoundedPlannerKnobName = keyof Pick<AutomaticTradingConfig, "min_sell_power_watts">;

export type PlannerKnobBounds = { defaultValue: number; min: number; max: number; unit: "W" };

export const PLANNER_KNOB_BOUNDS = {
  // A leftover budget the greedy can't fit at full power is sold at the largest power that still keeps the
  // reserve floor (planner.ts). 1.5 kW for 15 min is ~0.37 kWh, under 1 SEK even at a 2.5 SEK peak: around the
  // min-gain bar, so anything smaller is crumbs that still cost a setpoint write and a ramp. The 500 W floor stays
  // clear of the 350 W baseline night feed, which the inverter feeds anyway. At or above max_sell_power_watts
  // the fallback is off: a slot is sold at full power or not at all.
  min_sell_power_watts: { defaultValue: 1500, min: 500, max: 15000, unit: "W" },
} as const satisfies Record<BoundedPlannerKnobName, PlannerKnobBounds>;

/**
 * A value that isn't a non-negative number falls back to the default; one outside the bounds is clamped to
 * them. Takes `unknown` because config.json is hand-editable.
 */
export function effectivePlannerKnob(
  knobName: BoundedPlannerKnobName,
  configuredValue: unknown
): { value: number; correction: string | undefined } {
  const { defaultValue, min, max, unit } = PLANNER_KNOB_BOUNDS[knobName];
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
