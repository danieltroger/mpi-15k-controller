import { useMQTTValues } from "./useMQTTValues";
import { createEffect, createResource, createSignal, untrack } from "solid-js";
import { Config, get_config_object } from "./config";
import { log } from "./logging";
import { deparallelize_no_drop } from "@depict-ai/utilishared/latest";
import { sha1 } from "./sha1";

export function prematureFloatBugWorkaround(
  mqttValues: ReturnType<typeof useMQTTValues>,
  configSignal: Awaited<ReturnType<typeof get_config_object>>
) {
  const [config] = configSignal;
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

  loginToDessmonitor(configSignal).then(result => console.log("Login result", result));
}

async function getConfiguredVoltage() {
  return 53;
}

async function setConfiguredVoltage(voltage: number) {
  // TODO
}

async function loginToDessmonitor(configSignal: Awaited<ReturnType<typeof get_config_object>>) {
  const [config, setConfig] = configSignal;
  const now = +new Date();
  const hashedPassword = sha1(untrack(config).dessmonitor_password!);
  const request = {
    action: "authSource",
    usr: untrack(config).dessmonitor_user!,
    source: "1",
    "company-key": untrack(config).dessmonitor_company_key,
  } as const;
  const asQueryStrings = new URLSearchParams(request).toString();
  const concatenated = now + hashedPassword + "&" + asQueryStrings;
  const hashedConcatenated = sha1(concatenated);
  const finalQuery = {
    sign: hashedConcatenated,
    salt: now + "",
    ...request,
  };
  const urlObject = new URL("https://web.dessmonitor.com/public/");
  urlObject.search = new URLSearchParams(finalQuery) + "";

  const response = await fetch(urlObject, {
    "headers": {
      "accept": "application/json, text/plain, */*",
      "accept-language": "en-GB,en-US;q=0.9,en;q=0.8",
      "cache-control": "no-cache",
      "pragma": "no-cache",
    },
    "referrer": "https://www.dessmonitor.com/",
    "referrerPolicy": "strict-origin-when-cross-origin",
    "body": null,
    "method": "GET",
    "mode": "cors",
    "credentials": "omit",
  });
  if (!response.ok) {
    throw new Error("Failed to login to dessmonitor, non-200 response: " + response.status);
  }

  const json = (await response.json()) as Config["savedAuth_do_not_edit"]["authApiReturn"];

  if (json.err !== 0 || !json.dat) {
    log("Decoded", json);
    throw new Error("Failed to login to dessmonitor, error code: " + json.err + " desc: " + json.desc);
  }

  log("Login to dessmonitor succeeded");
  setConfig(prev => ({ ...prev, savedAuth_do_not_edit: { createdAt: now, authApiReturn: json } }));
}
