import { get_config_object } from "../config";
import { createMemo } from "solid-js";
import { reactiveBatteryCurrent, reactiveBatteryVoltage, reactiveBatteryVoltageTime } from "../mqttValues/mqttHelpers";

export function useLastFullAndEmpty([config]: Awaited<ReturnType<typeof get_config_object>>) {
  const haveSeenBatteryFullAt = createMemo<number | undefined>(prev => {
    const voltage = reactiveBatteryVoltage();
    const current = reactiveBatteryCurrent();
    if (voltage == undefined || current == undefined) return prev;
    if (voltage >= config().full_battery_voltage && current < config().stop_charging_below_current) {
      return reactiveBatteryVoltageTime();
    }
    return prev;
  });

  const haveSeenBatteryEmptyAt = createMemo<number | undefined>(prev => {
    const voltage = reactiveBatteryVoltage();
    if (voltage == undefined) return prev;
    if (voltage <= config().soc_calculations.battery_empty_at) {
      return reactiveBatteryVoltageTime();
    }
    return prev;
  });

  return {
    lastBatterySeenFullSinceProgramStart: haveSeenBatteryFullAt,
    lastBatterySeenEmptySinceProgramStart: haveSeenBatteryEmptyAt,
  };
}
