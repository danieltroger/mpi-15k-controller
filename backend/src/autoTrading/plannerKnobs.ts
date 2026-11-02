/**
 * The planner's knobs from a (merged) config, shared by the live trader and the dry-run preview: the
 * automatic_trading section verbatim, the knobs with backend-enforced bounds corrected to them
 * (plannerKnobBounds.ts, terminalValue.ts), and the two values that live elsewhere in the config.
 */
import type { Config } from "../config/config.types.ts";
import { warnLog } from "../utilities/logging.ts";
import { type BoundedPlannerKnobName, effectivePlannerKnob } from "./plannerKnobBounds.ts";
import { effectiveTerminalValueMode, effectiveTerminalValueMonths } from "./terminalValue.ts";
import type { PlannerKnobs } from "./planner.types.ts";

type CorrectedKnobName = BoundedPlannerKnobName | "terminal_value_mode" | "terminal_value_months";

/** The correction last warned about per knob: a bad value warns once, not on every 15-min plan run */
const lastWarnedCorrections = new Map<CorrectedKnobName, string>();

export function plannerKnobsFromConfig(cfg: Config): PlannerKnobs {
  const tradingConfig = cfg.automatic_trading;
  return {
    ...tradingConfig,
    min_sell_power_watts: boundedKnobValue("min_sell_power_watts", tradingConfig.min_sell_power_watts),
    fragmentation_tolerance_sek_per_window: boundedKnobValue(
      "fragmentation_tolerance_sek_per_window",
      tradingConfig.fragmentation_tolerance_sek_per_window
    ),
    terminal_value_mode: correctedKnobValue(
      "terminal_value_mode",
      effectiveTerminalValueMode(tradingConfig.terminal_value_mode)
    ),
    terminal_value_scale: boundedKnobValue("terminal_value_scale", tradingConfig.terminal_value_scale),
    terminal_value_trailing_days: boundedKnobValue(
      "terminal_value_trailing_days",
      tradingConfig.terminal_value_trailing_days
    ),
    terminal_value_months: correctedKnobValue(
      "terminal_value_months",
      effectiveTerminalValueMonths(tradingConfig.terminal_value_months)
    ),
    runtime_soc_floor_percent: Number(cfg.scheduled_power_selling.only_sell_above_soc),
    baseline_feed_watts: cfg.feed_from_battery_when_no_solar.feed_amount_watts,
  };
}

function boundedKnobValue(knobName: BoundedPlannerKnobName, configuredValue: unknown): number {
  return correctedKnobValue(knobName, effectivePlannerKnob(knobName, configuredValue));
}

function correctedKnobValue<Value>(
  knobName: CorrectedKnobName,
  { value, correction }: { value: Value; correction: string | undefined }
): Value {
  if (!correction) {
    lastWarnedCorrections.delete(knobName);
    return value;
  }
  if (lastWarnedCorrections.get(knobName) !== correction) {
    warnLog(
      `automatic_trading.${knobName}: ${correction} (the planner uses ${JSON.stringify(value)} until it's fixed)`
    );
    lastWarnedCorrections.set(knobName, correction);
  }
  return value;
}
