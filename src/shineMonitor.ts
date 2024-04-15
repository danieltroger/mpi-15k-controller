import { Config, get_config_object } from "./config";
import { untrack } from "solid-js";
import { sha1 } from "./sha1";
import { log } from "./logging";

const shineUrl = "https://ios.shinemonitor.com/public/";
export const clientInfo = {
  "_app_id_": "wifiapp.volfw.solarpower",
  "_app_version_": "1.9.1",
  "_app_client_": "ios",
} as const;

export async function makeRequestWithAuth(
  configSignal: Awaited<ReturnType<typeof get_config_object>>,
  initialRequest: Record<string, string>,
  action = "queryDeviceCtrlValue"
) {
  const auth = await getValidAuth(configSignal);
  const {
    dat: { secret, token },
  } = auth;
  const now = +new Date();
  const requestPart = { action, source: "1", ...initialRequest };
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
