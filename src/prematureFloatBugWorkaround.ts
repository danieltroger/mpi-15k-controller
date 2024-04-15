import { useMQTTValues } from "./useMQTTValues";
import { createEffect, createResource, createSignal, onCleanup, untrack } from "solid-js";
import { Config, get_config_object } from "./config";
import { error, log } from "./logging";
import { deparallelize_no_drop } from "@depict-ai/utilishared/latest";
import { sha1 } from "./sha1";

const shineUrl = "https://ios.shinemonitor.com/public/";
const clientInfo = { "_app_id_": "wifiapp.volfw.solarpower", "_app_version_": "1.9.1", "_app_client_": "ios" } as const;

export function prematureFloatBugWorkaround(
  mqttValues: ReturnType<typeof useMQTTValues>,
  configSignal: Awaited<ReturnType<typeof get_config_object>>
) {
  const [config] = configSignal;
  const [currentlySetChargeVoltage, { refetch }] = createResource(getConfiguredVoltageFromShinemonitor);
  const [settableChargeVoltage, setSettableChargeVoltage] = createSignal<number | undefined>();
  const getVoltage = () => mqttValues.battery_voltage?.value && (mqttValues.battery_voltage.value as number) / 10;
  const getCurrent = () => mqttValues.battery_current?.value && (mqttValues.battery_current?.value as number) / 10;
  const deparallelizedSetChargeVoltage = deparallelize_no_drop(async targetVoltage => {
    await setConfiguredVoltageInShinemonitor(configSignal, targetVoltage);
    refetch();
  });
  const refetchInterval = setInterval(refetch, 1000 * 60 * 10); // refetch every ten minutes so we diff against the latest value

  onCleanup(() => clearInterval(refetchInterval));

  createEffect(() => {
    const voltage = getVoltage();
    const startChargingBelow = config().start_bulk_charge_voltage;
    if (!voltage) return;
    if (voltage < startChargingBelow) {
      setSettableChargeVoltage(config().full_battery_voltage);
    } else if (voltage >= config().full_battery_voltage && (getCurrent() as number) < 10) {
      setSettableChargeVoltage(config().float_charging_voltage);
    }
  });

  createEffect(() => currentlySetChargeVoltage() && setSettableChargeVoltage(currentlySetChargeVoltage()!));

  createEffect(() => {
    const wantsVoltage = settableChargeVoltage();
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

async function getConfiguredVoltageFromShinemonitor(configSignal: Awaited<ReturnType<typeof get_config_object>>) {
  return 43;
}

async function setConfiguredVoltageInShinemonitor(
  configSignal: Awaited<ReturnType<typeof get_config_object>>,
  voltage: number
) {
  const [config] = configSignal;
  const result = await makeRequestWithAuth(configSignal, {
    "sn": untrack(config).inverter_sn!,
    "id": "bat_charging_float_voltage",
    "pn": untrack(config).inverter_pn!,
    "devcode": "2454",
    "val": voltage.toFixed(1),
    "devaddr": "1",
    ...clientInfo,
  });
  if (result.err) {
    error("Failed to set voltage in shinemonitor", result);
  }
  log("Successfully set voltage in shinemonitor to", voltage, result);
}

async function makeRequestWithAuth(
  configSignal: Awaited<ReturnType<typeof get_config_object>>,
  initialRequest: Record<string, string>
) {
  const auth = await getValidAuth(configSignal);
  const {
    dat: { secret, token },
  } = auth;
  const now = +new Date();
  const requestPart = { action: "ctrlDevice", source: "1", ...initialRequest };
  const asQueryString = new URLSearchParams(requestPart) + "";
  const sign = sha1(now + secret + token + "&" + asQueryString);
  const actualParams = new URLSearchParams({
    sign: sign,
    salt: now + "",
    token: token,
    ...requestPart,
  });
  const urlObject = new URL(shineUrl);
  urlObject.search = actualParams + "";

  const response = await fetch(urlObject, {
    headers: {
      "User-Agent": "SolarPower/1.9.1 (iPad; iOS 17.4; Scale/2.00)",
      "Accept-Language": "en-SE;q=1, sv-SE;q=0.9",
      "Accept": "*/*",
    },
  });

  if (!response.ok) {
    throw new Error("Failed to make request to shinemonitor, non-200 response: " + response.status);
  }
  const decoded = (await response.json()) as {
    err: number;
    desc: string;
    dat: {
      dat: string;
      status: number;
    };
  };

  return decoded;
}

async function getValidAuth(configSignal: Awaited<ReturnType<typeof get_config_object>>) {
  const [config] = configSignal;
  const saved = untrack(config).savedAuth_do_not_edit;
  if (saved) {
    const {
      createdAt,
      authApiReturn: {
        dat: { expire },
      },
    } = saved;
    if (createdAt + expire < +new Date()) {
      return saved.authApiReturn;
    }
  }
  return await loginToShinemonitor(configSignal);
}

async function loginToShinemonitor(configSignal: Awaited<ReturnType<typeof get_config_object>>) {
  log("Logging in to shinemonitor");
  const [config, setConfig] = configSignal;
  const now = +new Date();
  const hashedPassword = sha1(untrack(config).shinemonitor_password!);
  const request = {
    action: "authSource",
    usr: untrack(config).shinemonitor_user!,
    source: "1",
    "company-key": untrack(config).shinemonitor_company_key,
  } as const;
  const asQueryStrings = new URLSearchParams(request).toString();
  const concatenated = now + hashedPassword + "&" + asQueryStrings;
  const hashedConcatenated = sha1(concatenated);
  const finalQuery = {
    ...clientInfo,
    sign: hashedConcatenated,
    salt: now + "",
    ...request,
  };
  const urlObject = new URL(shineUrl);
  urlObject.search = new URLSearchParams(finalQuery) + "";

  const response = await fetch(urlObject, {
    headers: {
      "User-Agent": "SolarPower/1.9.1 (iPad; iOS 17.4; Scale/2.00)",
      "Accept-Language": "en-SE;q=1, sv-SE;q=0.9",
      "Accept": "*/*",
    },
  });
  if (!response.ok) {
    throw new Error("Failed to login to shinemonitor, non-200 response: " + response.status);
  }

  const json = (await response.json()) as NonNullable<Config["savedAuth_do_not_edit"]>["authApiReturn"];

  if (json.err !== 0 || !json.dat) {
    log("Decoded", json);
    throw new Error("Failed to login to shinemonitor, error code: " + json.err + " desc: " + json.desc);
  }

  log("Login to shinemonitor succeeded");
  setConfig(prev => ({ ...prev, savedAuth_do_not_edit: { createdAt: now, authApiReturn: json } }));

  return json;
}
