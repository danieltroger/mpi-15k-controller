import { type Accessor, createMemo } from "solid-js";
import type { Config } from "../config/config.types.ts";
import type { useTemperatures } from "../temperatureMeasuring/useTemperatures.ts";
import { useFromMqttProvider } from "../mqttValues/MQTTValuesProvider.ts";
import { useNow } from "../utilities/useNow.ts";
import { logLog, warnLog } from "../utilities/logging.ts";
import { boundedTradingKnob } from "../autoTrading/plannerKnobs.ts";
import { batteryProbeReadings } from "../temperatureMeasuring/batteryProbes.ts";
import {
  holdGuardMinBatteryCelsius,
  type HoldGuardSettings,
  holdGuardStartState,
  type HoldGuardState,
  type HoldGuardTransition,
  projectedHoldGridAmps,
  stepHoldWindowGuard,
} from "./holdWindowGuard.ts";

/**
 * Live wiring for the hold guard (holdWindowGuard.ts): projects the hold's per-phase grid current from the
 * readings the buy fuse logic uses (with their arrival times, so a stalled poll counts as missing), takes
 * the coldest battery probe, steps the guard at least every useNow tick and logs every drop-out (a warning:
 * the breakers came close, or the guard went blind) and re-entry.
 */
export function useHoldWindowGuard(inputs: {
  config: Accessor<Config>;
  /** A hold window is wanted right now (scheduledBuyDecision.ts) */
  holdWanted: Accessor<boolean>;
  /** Its charging power, W */
  holdWatts: Accessor<number>;
  /** Inverter idle draw, W (inverterIdleWatts, as the buy fuse logic leaves headroom for) */
  idleConsumptionWatts: Accessor<number>;
  temperatures: ReturnType<typeof useTemperatures>;
}): { holdAllowed: Accessor<boolean> } {
  const { mqttValues } = useFromMqttProvider();
  const settings = createMemo(() => holdGuardSettings(inputs.config()));
  const guardState = createMemo<HoldGuardState>(previous => {
    const nowMs = useNow();
    const overheadWatts = boundedTradingKnob(
      "hold_overhead_watts",
      inputs.config().automatic_trading.hold_overhead_watts
    );
    const grid = projectedHoldGridAmps({
      nowMs,
      activeWatts: {
        r: mqttValues.ac_output_active_power_r,
        s: mqttValues.ac_output_active_power_s,
        t: mqttValues.ac_output_active_power_t,
      },
      apparentWatts: {
        r: mqttValues.ac_output_apparent_power_r,
        s: mqttValues.ac_output_apparent_power_s,
        t: mqttValues.ac_output_apparent_power_t,
      },
      gridVolts: {
        r: mqttValues.ac_input_voltage_r,
        s: mqttValues.ac_input_voltage_s,
        t: mqttValues.ac_input_voltage_t,
      },
      inverterAndTrickleWatts: inputs.idleConsumptionWatts() + overheadWatts + inputs.holdWatts(),
    });
    const probeTemperatures = batteryProbeReadings(Object.values(inputs.temperatures()).map(reading => reading())).map(
      reading => reading.value
    );
    const coldestBatteryCelsius = probeTemperatures.length ? Math.min(...probeTemperatures) : undefined;
    const { state, transition } = stepHoldWindowGuard(
      previous,
      { nowMs, holdWanted: inputs.holdWanted(), readings: { grid, coldestBatteryCelsius } },
      settings()
    );
    if (transition) logHoldGuardTransition(transition);
    return state;
  }, holdGuardStartState(Date.now()));
  return { holdAllowed: createMemo(() => guardState().phase === "allowed") };
}

/** The guard's settings from the config, the automatic_trading knobs corrected to their bounds (warned once) */
export function holdGuardSettings(config: Config): HoldGuardSettings {
  const tradingConfig = config.automatic_trading;
  return {
    maxGridInputAmps: config.scheduled_power_buying.max_grid_input_amperage,
    gridMarginAmps: boundedTradingKnob("hold_grid_margin_amps", tradingConfig.hold_grid_margin_amps),
    reentryMinutes: boundedTradingKnob("hold_reentry_minutes", tradingConfig.hold_reentry_minutes),
    minBatteryCelsius: holdGuardMinBatteryCelsius(
      boundedTradingKnob("hold_min_battery_temp_celsius", tradingConfig.hold_min_battery_temp_celsius),
      config.alerting.charging_battery_temp_p1_celsius
    ),
  };
}

/**
 * A warning per drop-out (the breakers came close, the battery is cold, or the guard went blind), a plain
 * line for one with no grid (the owner switches it off some nights) and per re-entry. The clearing after a
 * controller start stays silent unless a hold was waiting for it: it happens at every start, hold or not.
 */
function logHoldGuardTransition(transition: HoldGuardTransition) {
  if (transition.kind === "dropped_out") {
    const message = `Hold guard: dropping out of the hold window — ${transition.reason}. AC charging switches off and the battery serves the house until it is safe again.`;
    if (transition.cause === "no_grid") logLog(message);
    else warnLog(message);
    return;
  }
  const minutesOut = Math.round(transition.droppedOutForMs / 60_000);
  if (transition.cause === "controller_start") {
    if (transition.holdWanted) {
      logLog(`Hold guard: starting the hold ${minutesOut} min after the controller start — ${transition.detail}`);
    }
    return;
  }
  logLog(
    transition.holdWanted
      ? `Hold guard: resuming the hold after ${minutesOut} min out — ${transition.detail}`
      : `Hold guard: clear again after ${minutesOut} min (no hold window now) — ${transition.detail}`
  );
}
