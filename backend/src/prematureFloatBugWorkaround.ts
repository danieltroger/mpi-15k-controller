import { useMQTTValues } from "./useMQTTValues";
import { Accessor, createEffect, createMemo, createResource, createSignal, onCleanup, untrack } from "solid-js";
import { get_config_object } from "./config";
import { error, log } from "./utilities/logging";
import { deparallelize_no_drop } from "@depict-ai/utilishared/latest";
import { GetVoltageResponse, makeRequestWithAuth, SetVoltageResponse } from "./shineMonitor";

const lastVoltageSet: { float?: number; bulk?: number } = {};

export function prematureFloatBugWorkaround({
  mqttValues,
  configSignal,
  energyRemovedSinceFull,
}: {
  mqttValues: ReturnType<typeof useMQTTValues>["mqttValues"];
  configSignal: Awaited<ReturnType<typeof get_config_object>>;
  energyRemovedSinceFull: Accessor<number | undefined>;
}) {
  const [config] = configSignal;
  const [localStateOfConfiguredVoltageFloat, { refetch: refetchFloat }] = createResource(() =>
    getConfiguredVoltageFromShinemonitor(configSignal, "float")
  );
  const [localStateOfConfiguredVoltageBulk, { refetch: refetchBulk }] = createResource(() =>
    getConfiguredVoltageFromShinemonitor(configSignal, "bulk")
  );
  const getVoltage = () => mqttValues.battery_voltage?.value && (mqttValues.battery_voltage.value as number) / 10;
  const getCurrent = () => mqttValues.battery_current?.value && (mqttValues.battery_current?.value as number) / 10;
  const deparallelizedSetChargeVoltageFloat = deparallelize_no_drop((targetVoltage: number) =>
    setVoltageWithThrottlingAndRefetch(configSignal, "float", targetVoltage, refetchFloat)
  );
  const deparallelizedSetChargeVoltageBulk = deparallelize_no_drop((targetVoltage: number) =>
    setVoltageWithThrottlingAndRefetch(configSignal, "bulk", targetVoltage, refetchBulk)
  );
  const refetchInterval = setInterval(() => (refetchBulk(), refetchFloat()), 1000 * 60 * 10); // refetch every ten minutes so we diff against the latest value
  const wantVoltagesToBeSetTo = createMemo<number | undefined>(prev => {
    const voltage = getVoltage();
    const startChargingBelow = config().start_bulk_charge_voltage;
    const { full_battery_voltage, start_bulk_charge_after_wh_discharged, float_charging_voltage } = config();
    if (!voltage) return prev;
    if (voltage <= startChargingBelow) {
      // Emergency voltage based charging, in case something breaks with DB or something
      return full_battery_voltage;
    } else if (voltage >= full_battery_voltage && (getCurrent() as number) < config().stop_charging_below_current) {
      // When battery full, stop charging
      return float_charging_voltage;
    }
    const removedSinceFull = energyRemovedSinceFull();
    if (!removedSinceFull) return prev;
    const shouldChargeDueToDischarged = removedSinceFull >= start_bulk_charge_after_wh_discharged;
    if (shouldChargeDueToDischarged) {
      if (untrack(wantVoltagesToBeSetTo) !== full_battery_voltage) {
        log(
          "Discharged",
          removedSinceFull,
          "wh since full, which is more than",
          start_bulk_charge_after_wh_discharged,
          "wh starting bulk charge"
        );
      }
      return full_battery_voltage;
    }
    return float_charging_voltage;
  });

  onCleanup(() => clearInterval(refetchInterval));

  createEffect(() => log("We now want the voltage to be set to", wantVoltagesToBeSetTo()));

  createEffect(() =>
    log("Got confirmed: configured float voltage from shinemonitor", localStateOfConfiguredVoltageFloat())
  );
  createEffect(() =>
    log("Got confirmed: configured bulk voltage from shinemonitor", localStateOfConfiguredVoltageBulk())
  );

  createEffect(() => {
    const wantsVoltage = wantVoltagesToBeSetTo();
    const voltageSetToRn = localStateOfConfiguredVoltageFloat();
    const bulkConfigured = localStateOfConfiguredVoltageBulk();
    if (
      !wantsVoltage ||
      !voltageSetToRn ||
      wantsVoltage === voltageSetToRn ||
      (bulkConfigured && wantsVoltage > bulkConfigured) // Disallow setting float voltage higher than bulk voltage (inverter will reject)
    ) {
      return;
    }
    log(
      "Queueing request to set float voltage to",
      wantsVoltage,
      ". We think the inverter is configured to",
      voltageSetToRn,
      "right now.",
      "Current voltage of battery",
      untrack(getVoltage),
      "V, current current of battery",
      untrack(getCurrent),
      "A"
    );
    deparallelizedSetChargeVoltageFloat(wantsVoltage);
  });

  createEffect(() => {
    const wantsVoltage = wantVoltagesToBeSetTo();
    const voltageSetToRn = localStateOfConfiguredVoltageBulk();
    const floatConfigured = localStateOfConfiguredVoltageFloat();
    if (
      !wantsVoltage ||
      !voltageSetToRn ||
      wantsVoltage === voltageSetToRn ||
      (floatConfigured && wantsVoltage < floatConfigured) // Disallow setting bulk voltage lower than float voltage (inverter will reject)
    )
      return;
    log(
      "Queueing request to set bulk voltage to",
      wantsVoltage,
      ". We think the inverter is configured to",
      voltageSetToRn,
      "right now.",
      "Current voltage of battery",
      untrack(getVoltage),
      "V, current current of battery",
      untrack(getCurrent),
      "A"
    );
    deparallelizedSetChargeVoltageBulk(wantsVoltage);
  });

  // Return this as "is charging" for feedWhenNoSolar, we say that we're charging if the actual float voltage equals the full battery voltage
  return createMemo(() => {
    if (energyRemovedSinceFull() == undefined) return undefined;
    return localStateOfConfiguredVoltageFloat() === config().full_battery_voltage;
  });
}

async function setVoltageWithThrottlingAndRefetch(
  configSignal: Awaited<ReturnType<typeof get_config_object>>,
  type: "float" | "bulk",
  targetVoltage: number,
  refetch: (info?: unknown) => number | Promise<number | undefined> | null | undefined
) {
  const now = +new Date();
  const setMaxEvery = 60_000;
  const setAgo = now - (lastVoltageSet[type] ?? 0);
  if (setAgo < setMaxEvery) {
    const waitFor = setMaxEvery - setAgo;
    log("Waiting with setting voltage for", waitFor, "ms, because it was set very recently");
    await new Promise(resolve => setTimeout(resolve, waitFor));
  }
  await setConfiguredVoltageInShinemonitor(configSignal, type, targetVoltage);
  lastVoltageSet[type] = +new Date();
  await refetch();
  setTimeout(refetch, 5000); // Inverter needs time for it to be set, so check again after 5s
}

async function getConfiguredVoltageFromShinemonitor(
  configSignal: Awaited<ReturnType<typeof get_config_object>>,
  type: "float" | "bulk"
) {
  const [config] = configSignal;
  const result = await makeRequestWithAuth<GetVoltageResponse>(configSignal, {
    "sn": untrack(config).inverter_sn!,
    "pn": untrack(config).inverter_pn!,
    "id": `bat_charging_${type}_voltage`,
    "devcode": "2454",
    "i18n": "en_US",
    "devaddr": "1",
    "source": "1",
  });
  if (result.err || result.dat.id !== `bat_charging_${type}_voltage_read`) {
    error("Failed to get voltage from shinemonitor", result);
    throw new Error("Failed to get voltage from shinemonitor (" + type + ")");
  }
  return parseFloat(result.dat.val);
}

async function setConfiguredVoltageInShinemonitor(
  configSignal: Awaited<ReturnType<typeof get_config_object>>,
  type: "float" | "bulk",
  voltage: number
) {
  const [config] = configSignal;
  const result = await makeRequestWithAuth<SetVoltageResponse>(
    configSignal,
    {
      "sn": untrack(config).inverter_sn!,
      "id": `bat_charging_${type}_voltage`,
      "pn": untrack(config).inverter_pn!,
      "devcode": "2454",
      "val": voltage.toFixed(1),
      "devaddr": "1",
    },
    "ctrlDevice"
  );
  if (result.err) {
    error("Failed to set voltage in shinemonitor", result, type, voltage);
    return;
  }
  log("Successfully set voltage in shinemonitor to", voltage, type, result);
}
