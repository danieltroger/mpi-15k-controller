import { useMQTTValues } from "./useMQTTValues";
import { get_config_object } from "./config";
import { Accessor, createEffect, createMemo, createSignal, untrack } from "solid-js";
import { useShinemonitorParameter } from "./useShinemonitorParameter";
import { log } from "./utilities/logging";
import { useNow } from "./utilities/useNow";

/**
 * The inverter always draws ~300w from the grid when it's not feeding into the grid (for unknown reasons), this function makes sure we're feeding from the battery if we're not feeding from the solar so that we're never pulling anything from the grid.
 */
export function feedWhenNoSolar({
  mqttValues,
  configSignal,
  isCharging,
}: {
  mqttValues: ReturnType<typeof useMQTTValues>["mqttValues"];
  configSignal: Awaited<ReturnType<typeof get_config_object>>;
  isCharging: Accessor<boolean | undefined>;
}) {
  let lastChange = 0;
  const now = useNow();
  const solarPower = () => {
    const array1 = mqttValues?.["solar_input_power_1"]?.value as number | undefined;
    const array2 = mqttValues?.["solar_input_power_2"]?.value as number | undefined;
    if (array1 == undefined && array2 == undefined) return undefined;
    return (array1 || 0) + (array2 || 0);
  };
  const acOutputPower = () => {
    const powerR = mqttValues?.["ac_output_active_power_r"]?.value as number | undefined;
    const powerS = mqttValues?.["ac_output_active_power_s"]?.value as number | undefined;
    const powerT = mqttValues?.["ac_output_active_power_t"]?.value as number | undefined;
    if (powerR == undefined && powerS == undefined && powerT == undefined) return undefined;
    return (powerR || 0) + (powerS || 0) + (powerT || 0);
  };
  const availablePowerThatWouldGoIntoTheGridByItself = createMemo(() => {
    const solar = solarPower();
    const acOutput = acOutputPower();
    if (solar == undefined || acOutput == undefined) return undefined;
    return solar - acOutput;
  });
  const [config] = configSignal;
  const feedBelow = createMemo(() => config().feed_from_battery_when_no_solar.feed_below_available_power);
  const getBatteryVoltage = () => {
    let voltage = mqttValues?.["battery_voltage"]?.value as number | undefined;
    if (voltage) {
      voltage /= 10;
    }
    return voltage;
  };
  // If we are between having reached nearly 58.4v the first time, and the charge process having completed due to no current flowing
  const batteryIsNearlyFull = createMemo<boolean | undefined>(prev =>
    getBatteryVoltage()! >= config().full_battery_voltage || isCharging() === false ? false : prev
  );
  const shouldEnableFeeding = createMemo<boolean | undefined>(prev => {
    if (now() - lastChange < 1000 * 60 * 5 && prev !== undefined) {
      // Don't change the state more often than every 5 minutes to prevent bounce and inbetween states that occur due to throttling in talking with shinemonitor
      return prev;
    }
    if (batteryIsNearlyFull()) {
      // When pushing in last percents, it's ok to buy like 75wh of electricity (think the math to prevent that would be complex or bouncy)
      return false;
    }
    // When charging, the battery will be able to take most of the energy until it's full, so we want to force-feed for the whole duration (tried power based but the calculations didn't work out)
    if (isCharging()) {
      const batteryVoltage = getBatteryVoltage();
      if (batteryVoltage != undefined && batteryVoltage < config().full_battery_voltage) {
        return true;
      }
    }

    let doIfBelow = feedBelow();
    if (prev) {
      // When already feeding, make the threshold to stop feeding higher to avoid weird oscillations
      doIfBelow += config().feed_from_battery_when_no_solar.add_to_feed_below_when_currently_feeding;
    }
    const available = availablePowerThatWouldGoIntoTheGridByItself();
    if (available == undefined) return undefined;
    const actuallyShouldNow = available < doIfBelow;
    if (actuallyShouldNow !== prev) {
      // We changed
      lastChange = +new Date();
    }
    return actuallyShouldNow;
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
    const shouldEnable = shouldEnableFeeding();
    if (shouldEnable == undefined) return;
    if (shouldEnable) {
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
    const { max_feed_in_power_when_feeding_from_solar, feed_amount_watts } = config().feed_from_battery_when_no_solar;
    const shouldFeed = shouldEnableFeeding();
    if (shouldFeed == undefined) return;
    if (!shouldFeed) {
      // Avoid feeding in a 15kw spike when disabling feeding from the battery - wait for the full power feed in to have been disabled so we only allow to feed in whatever comes from the panels
      if (currentBatteryToUtilityWhenSolar() === "Enable" && currentBatteryToUtilityWhenNoSolar() === "Enable") {
        return;
      }
    }
    const target = shouldFeed ? feed_amount_watts : max_feed_in_power_when_feeding_from_solar;
    setWantedMaxFeedInPower(target.toFixed(0));
  });

  createEffect(
    () =>
      shouldEnableFeeding() != undefined &&
      log(
        `We now ${shouldEnableFeeding() ? `*should*` : `should *not*`} feeding from the battery when no solar, because we have`,
        untrack(availablePowerThatWouldGoIntoTheGridByItself),
        "available power and we should feed below",
        untrack(feedBelow),
        `. The battery is ${untrack(isCharging) ? "charging" : "discharging"} and at`,
        untrack(getBatteryVoltage),
        `v. We have`,
        untrack(solarPower),
        "watts coming from solar, and",
        untrack(acOutputPower),
        `is being drawn by ac output. The battery is ${untrack(batteryIsNearlyFull) ? "" : "not "}in the last charging phase`
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
