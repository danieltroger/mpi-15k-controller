import { type Accessor, createEffect, createMemo, untrack } from "solid-js";
import type { Config } from "../config/config.types.ts";
import { useFromMqttProvider } from "../mqttValues/MQTTValuesProvider.ts";
import { logLog, warnLog } from "../utilities/logging.ts";
import { OVERHEAT_SELL_STOP_BOOT_STATE, type OverheatSellStopState, stepOverheatSellStop } from "./overheatSellStop.ts";

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

  createEffect(() => {
    const { sellingStopped, flipReading } = overheatSellStop();
    // Boot state: nothing has crossed a limit yet
    if (!flipReading) return;
    const { only_sell_below_inverter_temp_celsius, start_selling_again_below_inverter_temp_celsius } =
      untrack(config).scheduled_power_selling;
    if (sellingStopped) {
      warnLog(
        `Inverter overheating: component_max_temperature ${flipReading.value}°C reached ${only_sell_below_inverter_temp_celsius}°C — stopping scheduled selling until it drops below ${start_selling_again_below_inverter_temp_celsius}°C`
      );
    } else {
      logLog(
        `Inverter cooled: component_max_temperature ${flipReading.value}°C is below ${start_selling_again_below_inverter_temp_celsius}°C — scheduled selling allowed again`
      );
    }
  });

  return overheatSellStop;
}
