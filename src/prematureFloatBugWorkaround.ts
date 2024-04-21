import { useMQTTValues } from "./useMQTTValues";
import { Accessor, createEffect, createMemo, createResource, createSignal, onCleanup, untrack } from "solid-js";
import { get_config_object } from "./config";
import { error, log } from "./logging";
import { deparallelize_no_drop } from "@depict-ai/utilishared/latest";
import { GetVoltageResponse, makeRequestWithAuth, SetVoltageResponse } from "./shineMonitor";

const lastVoltageSet: { float?: number; bulk?: number } = {};

export function prematureFloatBugWorkaround({
  mqttValues,
  configSignal,
  energyDischargedSinceFull,
  energyChargedSinceFull,
}: {
  mqttValues: ReturnType<typeof useMQTTValues>;
  configSignal: Awaited<ReturnType<typeof get_config_object>>;
  energyDischargedSinceFull: Accessor<number | undefined>;
  energyChargedSinceFull: Accessor<number | undefined>;
}) {
  const [config] = configSignal;
  const [localStateOfConfiguredVoltageFloat, { refetch: refetchFloat }] = createResource(() =>
    getConfiguredVoltageFromShinemonitor(configSignal, "float")
  );
  const [localStateOfConfiguredVoltageBulk, { refetch: refetchBulk }] = createResource(() =>
    getConfiguredVoltageFromShinemonitor(configSignal, "bulk")
  );
  const [settableChargeVoltage, setSettableChargeVoltage] = createSignal<number | undefined>();
  const getVoltage = () => mqttValues.battery_voltage?.value && (mqttValues.battery_voltage.value as number) / 10;
  const getCurrent = () => mqttValues.battery_current?.value && (mqttValues.battery_current?.value as number) / 10;
  const deparallelizedSetChargeVoltageFloat = deparallelize_no_drop((targetVoltage: number) =>
    setVoltageWithThrottlingAndRefetch(configSignal, "float", targetVoltage, refetchFloat)
  );
  const deparallelizedSetChargeVoltageBulk = deparallelize_no_drop((targetVoltage: number) =>
    setVoltageWithThrottlingAndRefetch(configSignal, "bulk", targetVoltage, refetchBulk)
  );
  const refetchInterval = setInterval(() => (refetchBulk(), refetchFloat()), 1000 * 60 * 10); // refetch every ten minutes so we diff against the latest value
  const energyRemovedSinceFull = createMemo(() => {
    const discharged = energyDischargedSinceFull();
    const charged = energyChargedSinceFull();
    if (charged == undefined && discharged == undefined) return 0;
    if (charged == undefined) return discharged;
    if (discharged == undefined) return charged;
    return discharged + charged;
  });

  onCleanup(() => clearInterval(refetchInterval));

  createEffect(() => {
    const voltage = getVoltage();
    const startChargingBelow = config().start_bulk_charge_voltage;
    if (!voltage) return;
    if (voltage <= startChargingBelow) {
      // Emergency voltage based charging, in case something breaks with DB or something
      setSettableChargeVoltage(config().full_battery_voltage);
      return;
    } else if (voltage >= config().full_battery_voltage && (getCurrent() as number) < 10) {
      // When battery full, stop charging
      setSettableChargeVoltage(config().float_charging_voltage);
      return;
    }
    const removedSinceFull = energyRemovedSinceFull();
    if (!removedSinceFull) return;
    const removedAbs = Math.abs(removedSinceFull);
    const { full_battery_voltage, start_bulk_charge_after_wh_discharged } = config();
    if (removedAbs >= start_bulk_charge_after_wh_discharged) {
      if (untrack(settableChargeVoltage) !== full_battery_voltage) {
        log(
          "Discharged",
          removedAbs,
          "wh since full, which is more than",
          start_bulk_charge_after_wh_discharged,
          "wh starting bulk charge"
        );
      }
      setSettableChargeVoltage(full_battery_voltage);
    }
  });

  createEffect(() =>
    log("Got confirmed: configured float voltage from shinemonitor", localStateOfConfiguredVoltageFloat())
  );
  createEffect(() =>
    log("Got confirmed: configured bulk voltage from shinemonitor", localStateOfConfiguredVoltageBulk())
  );

  createEffect(() => {
    const wantsVoltage = settableChargeVoltage();
    const voltageSetToRn = localStateOfConfiguredVoltageFloat();
    if (!wantsVoltage || !voltageSetToRn || wantsVoltage === voltageSetToRn) return;
    log(
      "Queueing request to set float voltage to",
      wantsVoltage,
      ". We think the inverter is configured to",
      voltageSetToRn,
      "right now.",
      "Current voltage of battery",
      untrack(getVoltage),
      "current current of battery",
      untrack(getCurrent)
    );
    deparallelizedSetChargeVoltageFloat(wantsVoltage);
  });

  createEffect(() => {
    const wantsVoltage = settableChargeVoltage();
    const voltageSetToRn = localStateOfConfiguredVoltageBulk();
    if (!wantsVoltage || !voltageSetToRn || wantsVoltage === voltageSetToRn) return;
    log(
      "Queueing request to set bulk voltage to",
      wantsVoltage,
      ". We think the inverter is configured to",
      voltageSetToRn,
      "right now.",
      "Current voltage of battery",
      untrack(getVoltage),
      "current current of battery",
      untrack(getCurrent)
    );
    deparallelizedSetChargeVoltageBulk(wantsVoltage);
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
  }
  log("Successfully set voltage in shinemonitor to", voltage, type, result);
}
