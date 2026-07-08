import { get_config_object } from "../config/config.ts";
import { type Accessor, createMemo } from "solid-js";
import { reactiveBatteryVoltage, reactiveBatteryVoltageTime } from "../mqttValues/mqttHelpers.ts";
import { fullConditionMet, emptyConditionMet } from "./anchorConditions.ts";

/**
 * Live "last seen full / empty" for the Wh baseline. Full now keys off the 1-min-smoothed HALL current
 * (sensor 2) rather than the inverter's battery_current, which under-reads by omitting self-consumption
 * and so let the pack look "still charging" past the real taper. Empty is unchanged (voltage only).
 */
export function useLastFullAndEmpty(
  [config]: Awaited<ReturnType<typeof get_config_object>>,
  smoothedBatteryCurrentAmps: Accessor<number | undefined>
) {
  const haveSeenBatteryFullAt = createMemo<number | undefined>(prev => {
    const voltage = reactiveBatteryVoltage();
    const smoothedAmps = smoothedBatteryCurrentAmps();
    if (voltage == undefined || smoothedAmps == undefined) return prev;
    if (fullConditionMet(voltage, smoothedAmps, config().full_battery_voltage, config().stop_charging_below_current)) {
      return reactiveBatteryVoltageTime();
    }
    return prev;
  });

  const haveSeenBatteryEmptyAt = createMemo<number | undefined>(prev => {
    const voltage = reactiveBatteryVoltage();
    if (voltage == undefined) return prev;
    if (emptyConditionMet(voltage, config().soc_calculations.battery_empty_at)) {
      return reactiveBatteryVoltageTime();
    }
    return prev;
  });

  return {
    lastBatterySeenFullSinceProgramStart: haveSeenBatteryFullAt,
    lastBatterySeenEmptySinceProgramStart: haveSeenBatteryEmptyAt,
  };
}
