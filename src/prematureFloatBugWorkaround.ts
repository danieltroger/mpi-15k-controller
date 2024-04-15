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
  const [localStateOfConfiguredVoltage, { refetch }] = createResource(() =>
    getConfiguredVoltageFromShinemonitor(configSignal)
  );
  const [voltageSimulation, setVoltageSimulation] = createSignal<number | undefined>();
  const [settableChargeVoltage, setSettableChargeVoltage] = createSignal<number | undefined>();
  const getVoltage = () =>
    voltageSimulation() || (mqttValues.battery_voltage?.value && (mqttValues.battery_voltage.value as number) / 10);
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
    await refetch();
    setTimeout(refetch, 5000); // Inverter needs time for it to be set
  });
  const refetchInterval = setInterval(refetch, 1000 * 60 * 10); // refetch every ten minutes so we diff against the latest value
  let i = 0;

  process.on("SIGUSR2", () => {
    console.log("Received SIGUSR2 signal");
    if (!i) {
      setVoltageSimulation(44);
      i = 1;
    } else if (i === 1) {
      setVoltageSimulation(59);
      i = 2;
    } else if (i === 2) {
      setVoltageSimulation();
      i = 0;
    }
    // Insert any logic you want to perform when SIGUSR2 is received
    // For example, you might want to initiate a graceful restart
  });
  createEffect(() => log("Simulating voltage", voltageSimulation()));

  onCleanup(() => clearInterval(refetchInterval));

  createEffect(() => {
    const voltage = getVoltage();
    const startChargingBelow = config().start_bulk_charge_voltage;
    if (!voltage) return;
    console.log("We believe voltage is", voltage);
    // TODO: add energy based logic
    if (voltage <= startChargingBelow) {
      console.log("Doing stuff", config().full_battery_voltage);
      setSettableChargeVoltage(config().full_battery_voltage);
    } else if (voltage >= config().full_battery_voltage && (getCurrent() as number) < 10) {
      setSettableChargeVoltage(config().float_charging_voltage);
    }
  });

  createEffect(() => localStateOfConfiguredVoltage() && setSettableChargeVoltage(localStateOfConfiguredVoltage()!));

  createEffect(() => log("Got configured voltage from shinemonitor", localStateOfConfiguredVoltage()));

  createEffect(() => log("settableChargeVoltage", settableChargeVoltage()));

  console.log("our pid", process.pid);

  createEffect(() => {
    const wantsVoltage = settableChargeVoltage();
    const voltageSetToRn = localStateOfConfiguredVoltage();
    if (!wantsVoltage || !voltageSetToRn || wantsVoltage === voltageSetToRn) return;
    log(
      "Queueing request to set charge voltage to",
      wantsVoltage,
      "we think the inverter is configured to",
      voltageSetToRn,
      "right now.",
      "Current voltage of battery",
      untrack(getVoltage),
      "current current of battery",
      untrack(getCurrent)
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
  return parseFloat(result.dat.val);
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
