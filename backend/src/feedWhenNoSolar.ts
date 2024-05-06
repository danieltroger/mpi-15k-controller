import { useMQTTValues } from "./useMQTTValues";
import { get_config_object } from "./config";
import { createEffect, createMemo, untrack } from "solid-js";
import { useShinemonitorParameter } from "./useShinemonitorParameter";
import { log } from "./utilities/logging";
import { useNow } from "./utilities/useNow";

/**
 * The inverter always draws ~300w from the grid when it's not feeding into the grid (for unknown reasons), this function makes sure we're feeding from the battery if we're not feeding from the solar so that we're never pulling anything from the grid.
 */
export function feedWhenNoSolar(
  mqttValues: ReturnType<typeof useMQTTValues>["mqttValues"],
  configSignal: Awaited<ReturnType<typeof get_config_object>>
  //currentBatteryPower: () => { value: number; time: number } | undefined
) {
  let lastChange = 0;
  const now = useNow();
  const solarPower = () =>
    ((mqttValues?.["solar_input_power_1"]?.value || 0) as number) +
    ((mqttValues?.["solar_input_power_2"]?.value || 0) as number);
  const acOutputPower = () =>
    ((mqttValues?.["ac_output_active_power_r"]?.value || 0) as number) +
    ((mqttValues?.["ac_output_active_power_s"]?.value || 0) as number) +
    ((mqttValues?.["ac_output_active_power_t"]?.value || 0) as number);
  const availablePowerThatWouldGoIntoTheGridByItself = createMemo(() => solarPower() - acOutputPower());
  const [config] = configSignal;
  const feedBelow = createMemo(() => config().feed_from_battery_when_no_solar.feed_below_available_power);
  const shouldEnableFeeding = createMemo<boolean>(prev => {
    if (now() - lastChange < 1000 * 60 * 5 && prev) {
      // Don't change the state more often than every 5 minutes to prevent bounce and inbetween states that occur due to throttling in talking with shinemonitor
      return prev;
    }
    return availablePowerThatWouldGoIntoTheGridByItself() < feedBelow();
  });
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
      if (currentShineMaxFeedInPower() === config().feed_from_battery_when_no_solar.feed_amount_watts.toFixed(1)) {
        // Only actually start feeding in once it's confirmed we won't start feeding with 15kw when we shouldn't
        setWantedBatteryToUtilityWhenNoSolar("49");
        setWantedBatteryToUtilityWhenSolar("49");
      }
    } else {
      setWantedBatteryToUtilityWhenNoSolar("48");
      setWantedBatteryToUtilityWhenSolar("48");
    }
  });

  createEffect(() => {
    shouldEnableFeeding();
    lastChange = +new Date();
  });

  createEffect(() => {
    const { max_feed_in_power_when_feeding_from_solar, feed_amount_watts } = config().feed_from_battery_when_no_solar;
    const shouldFeed = shouldEnableFeeding();
    if (!shouldFeed) {
      // Avoid feeding in a 15kw spike when disabling feeding from the battery - wait for the full power feed in to have been disabled so we only allow to feed in whatever comes from the panels
      if (currentBatteryToUtilityWhenSolar() === "Enable" && currentBatteryToUtilityWhenNoSolar() === "Enable") {
        return;
      }
    }
    const target = shouldFeed ? feed_amount_watts : max_feed_in_power_when_feeding_from_solar;
    setWantedMaxFeedInPower(target.toFixed(0));
  });

  createEffect(() =>
    log(
      "We should be feeding from the battery when no solar:",
      shouldEnableFeeding(),
      "because we have",
      untrack(availablePowerThatWouldGoIntoTheGridByItself),
      "available power and we should feed below",
      untrack(feedBelow)
    )
  );

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
