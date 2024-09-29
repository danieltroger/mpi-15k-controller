import { Accessor, createEffect, createSignal } from "solid-js";
import { Config } from "../config";

/**
 * When ac output power suddenly rises, the inverter will pull power from the grid even though it shouldn't. Increment the amount that we feed into the grid already to counteract the inverters own consumption from the grid by even more to ensure the peak is covered by energy from the battery instead.
 */
export function useOutputPowerSuddenlyRose(acOutputPower: Accessor<undefined | number>, config: Accessor<Config>) {
  let resetTimeout: NodeJS.Timeout | undefined;
  const [outputPowerSuddenlyRose, setOutputPowerSuddenlyRose] = createSignal(false);
  createEffect<number | undefined>(prev => {
    const latestValue = acOutputPower();
    if (latestValue == undefined || prev == undefined) {
      return latestValue;
    }
    const { peak_min_change, peak_increment_duration } = config().feed_from_battery_when_no_solar;
    if (latestValue - prev > peak_min_change) {
      setOutputPowerSuddenlyRose(true);
      clearTimeout(resetTimeout);
      resetTimeout = setTimeout(() => setOutputPowerSuddenlyRose(false), peak_increment_duration * 1000);
    }
    return latestValue;
  });

  return outputPowerSuddenlyRose;
}
