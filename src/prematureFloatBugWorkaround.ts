import { useMQTTValues } from "./useMQTTValues";
import { createEffect, createResource, createSignal } from "solid-js";
import { get_config_object } from "./config";
import { log } from "./logging";
import { deparallelize_no_drop } from "@depict-ai/utilishared/latest";

export function prematureFloatBugWorkaround(
  mqttValues: ReturnType<typeof useMQTTValues>,
  config: Awaited<ReturnType<typeof get_config_object>>[0]
) {
  const [currentlySetChargeVoltage, { refetch }] = createResource(getConfiguredVoltage);
  const [configuredChargeVoltage, setConfiguredChargeVoltage] = createSignal<number | undefined>();
  const getVoltage = () => mqttValues.battery_voltage?.value && (mqttValues.battery_voltage.value as number) / 10;
  const getCurrent = () => mqttValues.battery_current?.value && (mqttValues.battery_current?.value as number) / 10;
  const deparallelizedSetChargeVoltage = deparallelize_no_drop(async targetVoltage => {
    await setConfiguredVoltage(targetVoltage);
    refetch();
  });

  createEffect(() => {
    const voltage = getVoltage();
    const startChargingBelow = config().start_bulk_charge_voltage;
    if (!voltage) return;
    if (voltage < startChargingBelow) {
      setConfiguredChargeVoltage(config().full_battery_voltage);
    } else if (voltage >= config().full_battery_voltage && (getCurrent() as number) < 10) {
      setConfiguredChargeVoltage(config().float_charging_voltage);
    }
  });

  createEffect(() => currentlySetChargeVoltage() && setConfiguredVoltage(currentlySetChargeVoltage()!));

  createEffect(() => {
    const wantsVoltage = configuredChargeVoltage();
    if (!wantsVoltage) return;
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

  createEffect(() => {
    console.log("Current", getCurrent(), "when:", mqttValues.battery_current?.time);
  });
}

async function getConfiguredVoltage() {
  return 53;
}

async function setConfiguredVoltage(voltage: number) {
  // TODO
}
