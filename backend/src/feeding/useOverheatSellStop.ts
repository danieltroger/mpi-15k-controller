import { type Accessor, createEffect, createMemo, untrack } from "solid-js";
import type { Config } from "../config/config.types.ts";
import { useFromMqttProvider } from "../mqttValues/MQTTValuesProvider.ts";
import { errorLog, logLog, warnLog } from "../utilities/logging.ts";
import {
  effectiveResumeBelowCelsius,
  MISORDERED_LIMITS_FALLBACK_GAP_CELSIUS,
  OVERHEAT_SELL_STOP_BOOT_STATE,
  overheatLimitsMisordered,
  type OverheatSellStopState,
  stepOverheatSellStop,
} from "./overheatSellStop.ts";

/**
 * Whether selling is stopped because the inverter is close to its over-temperature latch (fault 57
 * at 100 °C, stays off until power-cycled). Re-evaluated on every GS round; the state object only
 * changes on a flip, so the sell export and the alerts downstream see one change per crossing.
 */
export function useOverheatSellStop(config: Accessor<Config>): Accessor<OverheatSellStopState> {
  const { mqttValues } = useFromMqttProvider();
  const overheatSellStop = createMemo<OverheatSellStopState>(
    previousState =>
      stepOverheatSellStop({
        ...config().scheduled_power_selling,
        previousState,
        reading: mqttValues.component_max_temperature,
        nowMs: Date.now(),
      }),
    OVERHEAT_SELL_STOP_BOOT_STATE
  );

  // A memo so the error fires once per misconfiguration, not on every config write
  const limitsMisordered = createMemo(() => overheatLimitsMisordered(config().scheduled_power_selling));
  createEffect(() => {
    if (!limitsMisordered()) return;
    const limits = untrack(config).scheduled_power_selling;
    errorLog(
      `Overheat sell stop misconfigured: start_selling_again_below_inverter_temp_celsius (${limits.start_selling_again_below_inverter_temp_celsius}°C) must sit at least one whole degree below only_sell_below_inverter_temp_celsius (${limits.only_sell_below_inverter_temp_celsius}°C) — the inverter reports whole °C, so a narrower gap leaves no reading that holds and selling would flap on and off. Until that's fixed, selling resumes only below ${effectiveResumeBelowCelsius(limits)}°C (the default ${MISORDERED_LIMITS_FALLBACK_GAP_CELSIUS}°C gap below the stop limit)`
    );
  });

  createEffect(() => {
    const { sellingStopped, flipReading } = overheatSellStop();
    // Boot state: nothing has crossed a limit yet
    if (!flipReading) return;
    const limits = untrack(config).scheduled_power_selling;
    const resumeBelowCelsius = effectiveResumeBelowCelsius(limits);
    if (sellingStopped) {
      warnLog(
        `Inverter overheating: component_max_temperature ${flipReading.value}°C reached ${limits.only_sell_below_inverter_temp_celsius}°C — stopping scheduled selling until it drops below ${resumeBelowCelsius}°C`
      );
    } else {
      logLog(
        `Inverter cooled: component_max_temperature ${flipReading.value}°C is below ${resumeBelowCelsius}°C — scheduled selling allowed again`
      );
    }
  });

  return overheatSellStop;
}
