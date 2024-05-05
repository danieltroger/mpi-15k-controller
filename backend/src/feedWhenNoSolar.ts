import { useMQTTValues } from "./useMQTTValues";
import { get_config_object } from "./config";
import { createEffect, createMemo } from "solid-js";
import { useShinemonitorParameter } from "./useShinemonitorParameter";
import { log } from "./utilities/logging";

/**
 * The inverter always draws ~300w from the grid when it's not feeding into the grid (for unknown reasons), this function makes sure we're feeding from the battery if we're not feeding from the solar so that we're never pulling anything from the grid.
 */
export function feedWhenNoSolar(
  mqttValues: ReturnType<typeof useMQTTValues>["mqttValues"],
  configSignal: Awaited<ReturnType<typeof get_config_object>>
) {
  const solarPower = () =>
    ((mqttValues?.["solar_input_power_1"]?.value || 0) as number) +
    ((mqttValues?.["solar_input_power_2"]?.value || 0) as number);
  const acOutputPower = () =>
    ((mqttValues?.["ac_output_active_power_r"]?.value || 0) as number) +
    ((mqttValues?.["ac_output_active_power_s"]?.value || 0) as number) +
    ((mqttValues?.["ac_output_active_power_t"]?.value || 0) as number);
  const availablePower = createMemo(() => solarPower() - acOutputPower());
  const [config] = configSignal;
  const feedBelow = createMemo(() => config().feed_from_battery_when_no_solar.feed_below_available_power);
  const shouldEnableFeeding = createMemo(() => availablePower() < feedBelow());
  const wantedToCurrentTransformerForDiffing = (wanted: string) => {
    if (wanted === "48") {
      return "Disable" as const;
    } else if (wanted === "49") {
      return "Enable" as const;
    }
    // Little lie so this function can fall-through in case we get in an unexpected value
    return wanted as "Disable";
  };

  const { setWantedValue: setWantedMaxFeedInPower, currentValue: currentShineMaxFeedInPower } =
    useShinemonitorParameter<string>({
      parameter: "gcp_set_max_feed_in_power",
      configSignal,
      wantedToCurrentTransformerForDiffing: wanted => parseFloat(wanted).toFixed(1),
    });

  const { setWantedValue: setWantedBatteryToUtilityWhenNoSolar, currentValue: currentBatteryToUtilityWhenNoSolar } =
    useShinemonitorParameter<"Enable" | "Disable", "48" | "49">({
      parameter: "cts_utility_when_solar_input_loss",
      configSignal,
      wantedToCurrentTransformerForDiffing,
    });
  const { setWantedValue: setWantedBatteryToUtilityWhenSolar, currentValue: currentBatteryToUtilityWhenSolar } =
    useShinemonitorParameter<"Enable" | "Disable", "48" | "49">({
      parameter: "cts_utility_when_solar_input_normal",
      configSignal,
      wantedToCurrentTransformerForDiffing,
    });

  createEffect(() => {
    if (shouldEnableFeeding()) {
      /* Example field description:
       {
        "id": "cts_utility_when_solar_input_loss",
        "name": "Allow battery to feed-in to the Grid when PV is unavailable",
        "item": [
          {
            "key": "48",
            "val": "Disable"
          },
          {
            "key": "49",
            "val": "Enable"
          }
        ]
      }
       */
      setWantedBatteryToUtilityWhenNoSolar("49");
      setWantedBatteryToUtilityWhenSolar("49");
    } else {
      setWantedBatteryToUtilityWhenNoSolar("48");
      setWantedBatteryToUtilityWhenSolar("48");
    }
  });

  createEffect(() => {
    const { max_feed_in_power_when_feeding_from_solar, feed_amount_watts } = config().feed_from_battery_when_no_solar;
    const target = shouldEnableFeeding() ? feed_amount_watts : max_feed_in_power_when_feeding_from_solar;
    setWantedMaxFeedInPower(target.toFixed(0));
  });

  createEffect(
    () =>
      currentShineMaxFeedInPower() &&
      log("Got confirmed from shinemonitor that the current max feed in power is", currentShineMaxFeedInPower())
  );
  createEffect(
    () =>
      currentBatteryToUtilityWhenNoSolar() &&
      log(
        'Got confirmed from shinemonitor, "Allow battery to feed-in to the Grid when PV is unavailable" is set to',
        currentBatteryToUtilityWhenNoSolar()
      )
  );
  createEffect(
    () =>
      currentBatteryToUtilityWhenSolar() &&
      log(
        'Got confirmed from shinemonitor, "Allow battery to feed-in to the Grid when PV is available" is set to',
        currentBatteryToUtilityWhenSolar()
      )
  );
}
