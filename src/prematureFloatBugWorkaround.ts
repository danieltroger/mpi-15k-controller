import { useMQTTValues } from "./useMQTTValues";
import { createEffect, createResource, createSignal, onCleanup, untrack } from "solid-js";
import { get_config_object } from "./config";
import { error, log } from "./logging";
import { deparallelize_no_drop } from "@depict-ai/utilishared/latest";
import { GetVoltageResponse, makeRequestWithAuth, SetVoltageResponse } from "./shineMonitor";

let lastVoltageSet = 0;

export function prematureFloatBugWorkaround(
  mqttValues: ReturnType<typeof useMQTTValues>,
  configSignal: Awaited<ReturnType<typeof get_config_object>>
) {
  const [config] = configSignal;
  const [currentlySetChargeVoltage, { refetch }] = createResource(() =>
    getConfiguredVoltageFromShinemonitor(configSignal)
  );
  const [settableChargeVoltage, setSettableChargeVoltage] = createSignal<number | undefined>();
  const getVoltage = () => mqttValues.battery_voltage?.value && (mqttValues.battery_voltage.value as number) / 10;
  const getCurrent = () => mqttValues.battery_current?.value && (mqttValues.battery_current?.value as number) / 10;
  const deparallelizedSetChargeVoltage = deparallelize_no_drop(async targetVoltage => {
    const now = +new Date();
    const setMaxEvery = 60_000;
    const setAgo = now - lastVoltageSet;
    if (setAgo < setMaxEvery) {
      log("Waiting with setting voltage because it was set very recently");
      await new Promise(resolve => setTimeout(resolve, setMaxEvery - setAgo));
    }
    await setConfiguredVoltageInShinemonitor(configSignal, targetVoltage);
    lastVoltageSet = +new Date();
    refetch();
  });
  const refetchInterval = setInterval(refetch, 1000 * 60 * 10); // refetch every ten minutes so we diff against the latest value

  onCleanup(() => clearInterval(refetchInterval));

  createEffect(() => {
    const voltage = getVoltage();
    const startChargingBelow = config().start_bulk_charge_voltage;
    if (!voltage) return;
    // TODO: add energy based logic
    if (voltage <= startChargingBelow) {
      setSettableChargeVoltage(config().full_battery_voltage);
    } else if (voltage >= config().full_battery_voltage && (getCurrent() as number) < 10) {
      setSettableChargeVoltage(config().float_charging_voltage);
    }
  });

  createEffect(() => currentlySetChargeVoltage() && setSettableChargeVoltage(currentlySetChargeVoltage()!));

  createEffect(() => {
    const wantsVoltage = settableChargeVoltage();
    if (!wantsVoltage || wantsVoltage === currentlySetChargeVoltage()) return;
    log(
      "Queueing request to set charge voltage to",
      wantsVoltage,
      "current voltage",
      getVoltage(),
      "current current",
      getCurrent()
    );
    deparallelizedSetChargeVoltage(wantsVoltage);
  });
}

async function getConfiguredVoltageFromShinemonitor(configSignal: Awaited<ReturnType<typeof get_config_object>>) {
  const [config] = configSignal;
  const result = await makeRequestWithAuth<GetVoltageResponse>(configSignal, {
    "sn": untrack(config).inverter_sn!,
    "pn": untrack(config).inverter_pn!,
    "id": "bat_charging_float_voltage",
    "devcode": "2454",
    "i18n": "en_US",
    "devaddr": "1",
    "source": "1",
  });
  if (result.err || result.dat.id !== "bat_charging_float_voltage_read") {
    error("Failed to get voltage from shinemonitor", result);
    throw new Error("Failed to get voltage from shinemonitor");
  }
  const currentVoltage = parseFloat(result.dat.val);
  log("Got configured voltage from shinemonitor", currentVoltage);
  return currentVoltage;
}

async function setConfiguredVoltageInShinemonitor(
  configSignal: Awaited<ReturnType<typeof get_config_object>>,
  voltage: number
) {
  const [config] = configSignal;
  const result = await makeRequestWithAuth<SetVoltageResponse>(
    configSignal,
    {
      "sn": untrack(config).inverter_sn!,
      "id": "bat_charging_float_voltage",
      "pn": untrack(config).inverter_pn!,
      "devcode": "2454",
      "val": voltage.toFixed(1),
      "devaddr": "1",
    },
    "ctrlDevice"
  );
  if (result.err) {
    error("Failed to set voltage in shinemonitor", result);
  }
  log("Successfully set voltage in shinemonitor to", voltage, result);
}
