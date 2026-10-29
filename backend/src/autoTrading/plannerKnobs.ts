/**
 * The planner's knobs from a (merged) config, shared by the live trader and the dry-run preview: the
 * automatic_trading section verbatim, the knobs with backend-enforced bounds corrected to them
 * (plannerKnobBounds.ts), and the two values that live elsewhere in the config.
 */
import type { Config } from "../config/config.types.ts";
import { warnLog } from "../utilities/logging.ts";
import { type BoundedPlannerKnobName, effectivePlannerKnob } from "./plannerKnobBounds.ts";
import type { PlannerKnobs } from "./planner.types.ts";

/** The correction last warned about per knob: a bad value warns once, not on every 15-min plan run */
const lastWarnedCorrections = new Map<BoundedPlannerKnobName, string>();

export function plannerKnobsFromConfig(cfg: Config): PlannerKnobs {
  const tradingConfig = cfg.automatic_trading;
  return {
    ...tradingConfig,
    min_sell_power_watts: boundedKnobValue("min_sell_power_watts", tradingConfig.min_sell_power_watts),
    runtime_soc_floor_percent: Number(cfg.scheduled_power_selling.only_sell_above_soc),
    baseline_feed_watts: cfg.feed_from_battery_when_no_solar.feed_amount_watts,
  };
}

function boundedKnobValue(knobName: BoundedPlannerKnobName, configuredValue: unknown): number {
  const { value, correction } = effectivePlannerKnob(knobName, configuredValue);
  if (!correction) {
    lastWarnedCorrections.delete(knobName);
    return value;
  }
  if (lastWarnedCorrections.get(knobName) !== correction) {
    warnLog(`automatic_trading.${knobName}: ${correction} (the planner uses ${value} until it's fixed)`);
    lastWarnedCorrections.set(knobName, correction);
  }
  return value;
}
