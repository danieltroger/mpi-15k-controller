import { get_config_object } from "../config";
import { Accessor, createEffect, createMemo, createSignal, onCleanup, Setter, untrack } from "solid-js";
import { useShinemonitorParameter } from "../useShinemonitorParameter";
import { error, log } from "../utilities/logging";
import { useNow } from "../utilities/useNow";
import { catchify } from "@depict-ai/utilishared/latest";
import { totalSolarPower } from "../utilities/totalSolarPower";
import { appendFile } from "fs/promises";
import { useOutputPowerSuddenlyRose } from "./useOutputPowerSuddenlyRose";
import { useSetBuyingParameters } from "../buying/useSetBuyingParameters";
import { useFromMqttProvider } from "../mqttValues/MQTTValuesProvider";

/**
 * The inverter always draws ~300w from the grid when it's not feeding into the grid (for unknown reasons), this function makes sure we're feeding from the battery if we're not feeding from the solar so that we're never pulling anything from the grid.
 */
export function feedWhenNoSolar({
  configSignal,
  isCharging,
  setLastReason,
  setLastChangingReason,
  exportAmountForSelling,
  chargingAmperageForBuying,
}: {
  configSignal: Awaited<ReturnType<typeof get_config_object>>;
  isCharging: Accessor<boolean | undefined>;
  setLastReason: Setter<{ what: string; when: number }>;
  setLastChangingReason: Setter<{ what: string; when: number }>;
  exportAmountForSelling: Accessor<number | undefined>;
  chargingAmperageForBuying: Accessor<number | undefined>;
}) {
  let debounceTimeout: ReturnType<typeof setTimeout> | undefined;
  let lastChange = 0;
  const { mqttValues } = useFromMqttProvider();

  const acOutputPower = () => {
    const powerR = mqttValues?.["ac_output_active_power_r"]?.value;
    const powerS = mqttValues?.["ac_output_active_power_s"]?.value;
    const powerT = mqttValues?.["ac_output_active_power_t"]?.value;
    if (powerR == undefined && powerS == undefined && powerT == undefined) return undefined;
    return (powerR || 0) + (powerS || 0) + (powerT || 0);
  };
  const string1Voltage = createMemo(() => {
    const voltage1 = mqttValues["solar_input_voltage_1"]?.value as number | undefined;
    if (voltage1 == undefined) return undefined;
    return voltage1 / 10;
  });
  const string2Voltage = createMemo(() => {
    const voltage2 = mqttValues["solar_input_voltage_2"]?.value as number | undefined;
    if (voltage2 == undefined) return undefined;
    return voltage2 / 10;
  });
  const availablePowerThatWouldGoIntoTheGridByItself = createMemo(() => {
    const solar = totalSolarPower(mqttValues);
    const acOutput = acOutputPower();
    if (solar == undefined || acOutput == undefined) return undefined;
    return solar - acOutput;
  });
  const [config] = configSignal;
  const feedBelow = createMemo(() => config().feed_from_battery_when_no_solar.feed_below_available_power);
  const incrementForAntiPeak = useOutputPowerSuddenlyRose(acOutputPower, config, mqttValues);
  const getBatteryVoltage = () => {
    let voltage = mqttValues?.["battery_voltage"]?.value;
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
    const importAmount = chargingAmperageForBuying();
    // If we should feed in power or charge from AC, ignore throttling and just do it
    const exportAmount = exportAmountForSelling();
    if (exportAmount && importAmount) {
      error(
        "Both import and export amount are set, this should not happen",
        exportAmount,
        importAmount,
        "ignoring them"
      );
    } else if (exportAmount) {
      return doWithReason(true, `exportAmountForSelling is ${exportAmount}`);
    } else if (importAmount) {
      return doWithReason(false, `chargingAmperageForBuying is ${importAmount}`);
    }
    const timeSinceLastChange = useNow() - lastChange;
    const minTimePassed = 1000 * 60 * 3;
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
        force_let_through_to_grid_over_pv_voltage1,
        force_let_through_to_grid_over_pv_voltage2,
      },
    } = config();
    const batteryVoltage = getBatteryVoltage();
    const charging = isCharging();
    const startForceFeedingFromSolarAt =
      full_battery_voltage - allow_switching_to_solar_feeding_during_charging_x_volts_below_full;
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
    // When charging, the battery will be able to take most of the energy until it's full, so we want to force-feed for the whole duration (tried power based but the calculations didn't work out)
    if (charging) {
      return doWithReason(true, "we are charging");
    }

    const solarVoltage1 = string1Voltage();
    const solarVoltage2 = string2Voltage();
    const over1 = solarVoltage1 != undefined && solarVoltage1 > force_let_through_to_grid_over_pv_voltage1;
    const over2 = solarVoltage2 != undefined && solarVoltage2 > force_let_through_to_grid_over_pv_voltage2;
    if (over1 || over2) {
      const reasons: string[] = [];
      if (over1) {
        reasons.push(
          `PV string 1 (${solarVoltage1}) is over force let through to grid voltage1 ${force_let_through_to_grid_over_pv_voltage1}v`
        );
      }
      if (over2) {
        reasons.push(
          `PV string 2 (${solarVoltage2}) is over force let through to grid voltage2 ${force_let_through_to_grid_over_pv_voltage2}v`
        );
      }
      return doWithReason(false, reasons.join(", "));
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

  const feedWhenForceFeedingAmount: Accessor<number> = createMemo(() => {
    const { feed_amount_watts } = config().feed_from_battery_when_no_solar;
    const toExport = exportAmountForSelling();
    if (toExport) {
      return Math.max(feed_amount_watts, toExport);
    }
    if (incrementForAntiPeak()) {
      return feed_amount_watts + incrementForAntiPeak();
    }
    return feed_amount_watts;
  });
  const { currentlyBuying } = useSetBuyingParameters({
    chargingAmperageForBuying,
    configSignal,
    stillFeedingIn: createMemo(
      () => currentBatteryToUtilityWhenSolar() !== "Disable" || currentBatteryToUtilityWhenNoSolar() !== "Disable"
    ),
  });

  debugLog(`feedWhenNoSolar started`);
  onCleanup(() => debugLog(`feedWhenNoSolar terminated (cleaned up)`));

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
      const currentlySetTo = currentShineMaxFeedInPower();
      if (currentlySetTo && parseFloat(currentlySetTo) === feedWhenForceFeedingAmount() && !currentlyBuying()) {
        // Only actually start feeding in once it's confirmed we won't start feeding with 15kw when we shouldn't. And that we're not still buying/AC Charging.
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
    const exporting = untrack(exportAmountForSelling);
    const importing = untrack(chargingAmperageForBuying);
    clearTimeout(debounceTimeout);
    if (currentDebouncedValue === undefined || (!(exporting && importing) && (exporting || importing))) {
      setDebouncedShouldEnableFeeding(shouldEnable);
      return;
    }
    debounceTimeout = setTimeout(
      catchify(() => setDebouncedShouldEnableFeeding(shouldEnable)),
      config().feed_from_battery_when_no_solar.should_feed_debounce_time
    );
  });

  createEffect(() => {
    const { max_feed_in_power_when_feeding_from_solar } = config().feed_from_battery_when_no_solar;
    const shouldFeed = debouncedShouldEnableFeeding();
    if (shouldFeed == undefined) return;
    if (!shouldFeed) {
      // Avoid feeding in a 15kw spike when disabling feeding from the battery - wait for the full power feed in to have been disabled so we only allow to feed in whatever comes from the panels
      if (currentBatteryToUtilityWhenSolar() !== "Disable" || currentBatteryToUtilityWhenNoSolar() !== "Disable") {
        return;
      }
    }
    const target = shouldFeed ? feedWhenForceFeedingAmount() : max_feed_in_power_when_feeding_from_solar;
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
  const date = new Date();
  const options = { timeZone: "Europe/Stockholm" };
  const localeString = date.toLocaleString("sv-SE", options);

  appendFile("/tmp/feedWhenNoSolar-debug.txt", localeString + " " + message + "\n", "utf8").catch(e =>
    error("Failed to log", message, "to feed when no solar debug", e)
  );
}
