import { Accessor, createEffect, createSignal } from "solid-js";
import { useMQTTValues } from "../mqttValues/useMQTTValues";
import { Config } from "../config/config.types";

/**
 * When ac output power suddenly rises, the inverter will pull power from the grid even though it shouldn't. Increment the amount that we feed into the grid already to counteract the inverters own consumption from the grid by even more to ensure the peak is covered by energy from the battery instead.
 */
export function useOutputPowerSuddenlyRose(
  acOutputPower: Accessor<undefined | number>,
  config: Accessor<Config>,
  mqttValues: ReturnType<typeof useMQTTValues>["mqttValues"]
) {
  const getPowerDirection = () => mqttValues.line_power_direction?.value;

  const [incrementForAntiPeak, setIncrementForAntiPeak] = createSignal(0);
  createEffect<number | undefined>(prev => {
    const latestValue = acOutputPower();
    if (latestValue == undefined || prev == undefined || getPowerDirection() === "Idle") {
      return latestValue;
    }
    const { peak_min_change, peak_increment_duration, increment_with_on_peak } =
      config().feed_from_battery_when_no_solar;
    if (latestValue - prev > peak_min_change) {
      setIncrementForAntiPeak(prev => prev + increment_with_on_peak);
      setTimeout(() => setIncrementForAntiPeak(prev => prev - increment_with_on_peak), peak_increment_duration * 1000);
    }
    return latestValue;
  });

  return incrementForAntiPeak;
}
