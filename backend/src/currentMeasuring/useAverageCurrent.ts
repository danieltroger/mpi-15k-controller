import { Accessor, createMemo, untrack } from "solid-js";
import { Config } from "../config";

export function useAverageCurrent({
  rawMeasurement,
  config,
}: {
  rawMeasurement: Accessor<{ value: number; time: number } | undefined>;
  config: Accessor<Config>;
}) {
  const values = new Set<{ value: number; time: number }>();
  let values_start = +new Date();

  return createMemo(() => {
    let returnValue: number | undefined;
    const currentValue = rawMeasurement();
    if (!currentValue) return; // Unsure if this can happen but just in case
    values.add(currentValue);
    const now = +new Date();
    if (now - values_start >= untrack(config).current_measuring.average_over_time_seconds) {
      const weighted_average = calculate_weighted_average({ values, now });
      if (!isNaN(weighted_average)) {
        // Don't report NaN averages when we got no data for a longer period
        returnValue = weighted_average;
      }
      values_start = now;
    }
    if (typeof returnValue !== undefined) return returnValue;
  });
}

function calculate_weighted_average({ values, now }: { values: Set<{ value: number; time: number }>; now: number }) {
  const values_as_array = [...values];
  let weighted_sum = 0;
  let duration_sum = 0;
  for (let i = 0; i < values_as_array.length; i++) {
    const this_value = values_as_array[i];
    const next_value = values_as_array[i + 1] as { value: number; time: number } | undefined;
    const duration_of_value = (next_value?.time ?? now) - this_value.time;
    weighted_sum += duration_of_value * this_value.value;
    duration_sum += duration_of_value;
  }
  values.clear();
  const weighted_average = weighted_sum / duration_sum;
  return weighted_average;
}
