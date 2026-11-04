/**
 * The planner's knobs from a (merged) config, shared by the live trader and the dry-run preview: the
 * automatic_trading section verbatim, the knobs with backend-enforced bounds corrected to them
 * (plannerKnobBounds.ts, terminalValue.ts), and the values that live elsewhere in the config (the meter
 * calibration corrected to its bounds, grid/correctedMeterCalibration.ts). The
 * runtime hold guard (buying/holdWindowGuard.ts) corrects its knobs through boundedTradingKnob too.
 */
import type { Config } from "../config/config.types.ts";
import { warnLog } from "../utilities/logging.ts";
import { plannerMeterCalibration } from "../grid/correctedMeterCalibration.ts";
import { type BoundedPlannerKnobName, effectivePlannerKnob } from "./plannerKnobBounds.ts";
import { effectiveTerminalValueMode, effectiveTerminalValueMonths } from "./terminalValue.ts";
import type { PlannerKnobs } from "./planner.types.ts";

type CorrectedKnobName = BoundedPlannerKnobName | "terminal_value_mode" | "terminal_value_months" | "hold_enabled";

/** The correction last warned about per knob: a bad value warns once, not on every 15-min plan run */
const lastWarnedCorrections = new Map<CorrectedKnobName, string>();

export function plannerKnobsFromConfig(cfg: Config): PlannerKnobs {
  const tradingConfig = cfg.automatic_trading;
  return {
    ...tradingConfig,
    min_sell_power_watts: boundedTradingKnob("min_sell_power_watts", tradingConfig.min_sell_power_watts),
    fragmentation_tolerance_sek_per_window: boundedTradingKnob(
      "fragmentation_tolerance_sek_per_window",
      tradingConfig.fragmentation_tolerance_sek_per_window
    ),
    terminal_value_mode: correctedKnobValue(
      "terminal_value_mode",
      effectiveTerminalValueMode(tradingConfig.terminal_value_mode)
    ),
    terminal_value_scale: boundedTradingKnob("terminal_value_scale", tradingConfig.terminal_value_scale),
    terminal_value_trailing_days: boundedTradingKnob(
      "terminal_value_trailing_days",
      tradingConfig.terminal_value_trailing_days
    ),
    terminal_value_min_saving_sek_per_kwh: boundedTradingKnob(
      "terminal_value_min_saving_sek_per_kwh",
      tradingConfig.terminal_value_min_saving_sek_per_kwh
    ),
    terminal_value_months: correctedKnobValue(
      "terminal_value_months",
      effectiveTerminalValueMonths(tradingConfig.terminal_value_months)
    ),
    terminal_value_forecast_max_deviation_sek: boundedTradingKnob(
      "terminal_value_forecast_max_deviation_sek",
      tradingConfig.terminal_value_forecast_max_deviation_sek
    ),
    terminal_value_forecast_max_age_hours: boundedTradingKnob(
      "terminal_value_forecast_max_age_hours",
      tradingConfig.terminal_value_forecast_max_age_hours
    ),
    terminal_value_forecast_wait_seconds: boundedTradingKnob(
      "terminal_value_forecast_wait_seconds",
      tradingConfig.terminal_value_forecast_wait_seconds
    ),
    terminal_value_solar_scale: boundedTradingKnob(
      "terminal_value_solar_scale",
      tradingConfig.terminal_value_solar_scale
    ),
    terminal_value_solar_lookahead_hours: boundedTradingKnob(
      "terminal_value_solar_lookahead_hours",
      tradingConfig.terminal_value_solar_lookahead_hours
    ),
    terminal_value_solar_forecast_max_age_hours: boundedTradingKnob(
      "terminal_value_solar_forecast_max_age_hours",
      tradingConfig.terminal_value_solar_forecast_max_age_hours
    ),
    hold_enabled: holdEnabledKnob(tradingConfig.hold_enabled),
    hold_power_watts: boundedTradingKnob("hold_power_watts", tradingConfig.hold_power_watts),
    hold_overhead_watts: boundedTradingKnob("hold_overhead_watts", tradingConfig.hold_overhead_watts),
    hold_net_dc_in_watts: boundedTradingKnob("hold_net_dc_in_watts", tradingConfig.hold_net_dc_in_watts),
    hold_margin_sek_per_kwh: boundedTradingKnob("hold_margin_sek_per_kwh", tradingConfig.hold_margin_sek_per_kwh),
    hold_min_window_minutes: boundedTradingKnob("hold_min_window_minutes", tradingConfig.hold_min_window_minutes),
    hold_bridge_minutes: boundedTradingKnob("hold_bridge_minutes", tradingConfig.hold_bridge_minutes),
    runtime_soc_floor_percent: Number(cfg.scheduled_power_selling.only_sell_above_soc),
    baseline_feed_watts: cfg.feed_from_battery_when_no_solar.feed_amount_watts,
    meter_calibration: plannerMeterCalibration(cfg.meter_calibration),
  };
}

/** A bounded automatic_trading knob corrected to its bounds, warning once per bad value */
export function boundedTradingKnob(knobName: BoundedPlannerKnobName, configuredValue: unknown): number {
  return correctedKnobValue(knobName, effectivePlannerKnob(knobName, configuredValue));
}

/** hold_enabled corrected (effectiveHoldEnabled), warning once per bad value: the planner's and the runtime's */
export function holdEnabledKnob(configuredValue: unknown): boolean {
  return correctedKnobValue("hold_enabled", effectiveHoldEnabled(configuredValue));
}

/** Only a boolean counts; anything else is off, with a warning. Takes `unknown`: config.json is hand-editable. */
export function effectiveHoldEnabled(configured: unknown): { value: boolean; correction: string | undefined } {
  if (typeof configured === "boolean") return { value: configured, correction: undefined };
  return { value: false, correction: `${JSON.stringify(configured)} is not true or false, using false` };
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
    const user = knobName.startsWith("hold_") ? "the planner and the hold guard use" : "the planner uses";
    warnLog(`automatic_trading.${knobName}: ${correction} (${user} ${JSON.stringify(value)} until it's fixed)`);
    lastWarnedCorrections.set(knobName, correction);
  }
  return value;
}
