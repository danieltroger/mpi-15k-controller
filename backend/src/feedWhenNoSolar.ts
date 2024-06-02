import { useMQTTValues } from "./useMQTTValues";
import { get_config_object } from "./config";
import { Accessor, createEffect, createMemo, createSignal, Setter, untrack } from "solid-js";
import { useShinemonitorParameter } from "./useShinemonitorParameter";
import { error, log } from "./utilities/logging";
import { useNow } from "./utilities/useNow";
import { catchify } from "@depict-ai/utilishared/latest";
import { totalSolarPower } from "./utilities/totalSolarPower";
import { appendFile } from "fs/promises";

/**
 * The inverter always draws ~300w from the grid when it's not feeding into the grid (for unknown reasons), this function makes sure we're feeding from the battery if we're not feeding from the solar so that we're never pulling anything from the grid.
 */
export function feedWhenNoSolar({
  mqttValues,
  configSignal,
  isCharging,
  setLastReason,
  setLastChangingReason,
}: {
  mqttValues: ReturnType<typeof useMQTTValues>["mqttValues"];
  configSignal: Awaited<ReturnType<typeof get_config_object>>;
  isCharging: Accessor<boolean | undefined>;
  setLastReason: Setter<{ what: string; when: number }>;
  setLastChangingReason: Setter<{ what: string; when: number }>;
}) {
  let debounceTimeout: ReturnType<typeof setTimeout> | undefined;
  let lastChange = 0;
  const now = useNow();

  const acOutputPower = () => {
    const powerR = mqttValues?.["ac_output_active_power_r"]?.value as number | undefined;
    const powerS = mqttValues?.["ac_output_active_power_s"]?.value as number | undefined;
    const powerT = mqttValues?.["ac_output_active_power_t"]?.value as number | undefined;
    if (powerR == undefined && powerS == undefined && powerT == undefined) return undefined;
    return (powerR || 0) + (powerS || 0) + (powerT || 0);
  };
  const highestStringVoltage = createMemo(() => {
    const voltage1 = mqttValues["solar_input_voltage_1"]?.value as number | undefined;
    const voltage2 = mqttValues["solar_input_voltage_1"]?.value as number | undefined;
    if (voltage1 == undefined && voltage2 == undefined) return undefined;
    return Math.max((voltage1 || 0) / 10, (voltage2 || 0) / 10);
  });
  const availablePowerThatWouldGoIntoTheGridByItself = createMemo(() => {
    const solar = totalSolarPower(mqttValues);
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
  const batteryIsNearlyFull = createMemo<boolean | undefined>(
    prev => getBatteryVoltage()! >= config().full_battery_voltage || (isCharging() === false ? false : prev)
  );

  const shouldEnableFeeding = createMemo<boolean | undefined>(prev => {
    const doWithReason = (what: boolean | undefined, reason: string) => {
      if (what !== prev) {
        // We changed
        lastChange = +new Date();
        debugLog(`Changed to ${what} because ${reason}`);
        setLastChangingReason({
          what: `shouldEnableFeeding last changed to ${what} because ${reason}`,
          when: +new Date(),
        });
      }
      setLastReason({ what: `shouldEnableFeeding currently wants to be ${what} because ${reason}`, when: +new Date() });
      return what;
    };
    const timeSinceLastChange = now() - lastChange;
    const minTimePassed = 1000 * 60 * 4;
    if (timeSinceLastChange < minTimePassed && prev !== undefined) {
      // Don't change the state more often than every 4 minutes to prevent bounce and inbetween states that occur due to throttling in talking with shinemonitor
      return doWithReason(
        prev,
        `not enough time passed since last change (${timeSinceLastChange}ms < ${minTimePassed}ms)`
      );
    }
    const {
      full_battery_voltage,
      feed_from_battery_when_no_solar: {
        disable_below_battery_voltage,
        allow_switching_to_solar_feeding_during_charging_x_volts_below_full,
        add_to_feed_below_when_currently_feeding,
        force_let_through_to_grid_over_pv_voltage,
      },
    } = config();
    const batteryVoltage = getBatteryVoltage();
    const charging = isCharging();
    const startForceFeedingFromSolarAt =
      full_battery_voltage - allow_switching_to_solar_feeding_during_charging_x_volts_below_full;
    const highestVoltage = highestStringVoltage();
    // Wait for data to be known at program start before making a decision
    if (batteryVoltage == undefined || charging == undefined) {
      return doWithReason(prev, "battery voltage or charging unknown");
    }
    if (batteryIsNearlyFull()) {
      return doWithReason(false, "battery is nearly full");
    }
    if (batteryVoltage <= disable_below_battery_voltage) {
      return doWithReason(
        false,
        `battery voltage ${batteryVoltage}v is below disable threshold ${disable_below_battery_voltage}v`
      );
    }
    if (
      // Switch back to feeding from solar already a bit before full to avoid a dip in harvested power, like here http://192.168.1.102:3000/d/cdhmg2rukhkw0d/first-dashboard?orgId=1&from=1716444771315&to=1716455606919
      charging &&
      batteryVoltage >= startForceFeedingFromSolarAt
    ) {
      // When pushing in last percents, it's ok to buy like 75wh of electricity (think the math to prevent that would be complex or bouncy)
      // Also when battery is basically completely depleted, don't attempt to feed it into the grid
      return doWithReason(
        false,
        `battery voltage ${batteryVoltage}v is above force feeding threshold ${startForceFeedingFromSolarAt}v`
      );
    }
    if (highestVoltage != undefined && highestVoltage > force_let_through_to_grid_over_pv_voltage) {
      return doWithReason(
        false,
        `highest voltage ${highestVoltage}v is above force let through threshold ${force_let_through_to_grid_over_pv_voltage}v`
      );
    }
    // When charging, the battery will be able to take most of the energy until it's full, so we want to force-feed for the whole duration (tried power based but the calculations didn't work out)
    if (charging) {
      return doWithReason(true, "we are charging");
    }

    let doIfBelow = feedBelow();
    if (prev) {
      // When already feeding, make the threshold to stop feeding higher to avoid weird oscillations
      doIfBelow += add_to_feed_below_when_currently_feeding;
    }
    const available = availablePowerThatWouldGoIntoTheGridByItself();
    if (available == undefined) {
      return doWithReason(prev, "available power unknown");
    }
    const actuallyShouldNow = available < doIfBelow;
    return doWithReason(
      actuallyShouldNow,
      `available power ${available}w is ${actuallyShouldNow ? "below" : "above"} threshold ${doIfBelow}w`
    );
  });
  const [debouncedShouldEnableFeeding, setDebouncedShouldEnableFeeding] = createSignal(untrack(shouldEnableFeeding));
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
    const shouldEnable = debouncedShouldEnableFeeding();
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

  // Add a debounce to every change of the value (wait for 1 minute for the value to change again before actually changing it) so that clouds coinciding with spikey power consumers don't reduce our grid feed in power unintentionally for like 10 minutes, see http://192.168.0.3:3002/d/cdhmg2rukhkw0d/first-dashboard?orgId=1&from=1715682530262&to=1715684400506
  createEffect(() => {
    const shouldEnable = shouldEnableFeeding();
    const currentDebouncedValue = untrack(debouncedShouldEnableFeeding);
    if (currentDebouncedValue === undefined) {
      setDebouncedShouldEnableFeeding(shouldEnable);
      return;
    }
    clearTimeout(debounceTimeout);
    debounceTimeout = setTimeout(
      catchify(() => setDebouncedShouldEnableFeeding(shouldEnable)),
      config().feed_from_battery_when_no_solar.should_feed_debounce_time
    );
  });

  createEffect(() => {
    const { max_feed_in_power_when_feeding_from_solar, feed_amount_watts } = config().feed_from_battery_when_no_solar;
    const shouldFeed = debouncedShouldEnableFeeding();
    if (shouldFeed == undefined) return;
    if (!shouldFeed) {
      // Avoid feeding in a 15kw spike when disabling feeding from the battery - wait for the full power feed in to have been disabled so we only allow to feed in whatever comes from the panels
      if (currentBatteryToUtilityWhenSolar() !== "Disable" && currentBatteryToUtilityWhenNoSolar() !== "Disable") {
        return;
      }
    }
    const target = shouldFeed ? feed_amount_watts : max_feed_in_power_when_feeding_from_solar;
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

function debugLog(message: string) {
  appendFile("/tmp/feedWhenNoSolar-debug.txt", new Date().toLocaleString() + " " + message + "\n", "utf8").catch(e =>
    error("Failed to log", message, "to feed when no solar debug", e)
  );
}
