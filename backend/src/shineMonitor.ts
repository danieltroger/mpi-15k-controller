import { get_config_object } from "./config/config";
import { untrack } from "solid-js";
import { sha1 } from "./utilities/sha1";
import { logLog } from "./utilities/logging";
import { Config } from "./config/config.types";

export type GetVoltageResponse = {
  err: number;
  desc: string;
  dat: {
    id: string;
    name: string;
    val: string;
  };
};

export type SetVoltageResponse = {
  err: number;
  desc: string;
  dat: {
    dat: string;
    status: number;
  };
};

let requestBeingMade: Promise<void> | undefined;

const shineUrl = "https://web.dessmonitor.com/public/";

export async function makeRequestWithAuth<T>(
  configSignal: Awaited<ReturnType<typeof get_config_object>>,
  initialRequest: Record<string, string>,
  action = "queryDeviceCtrlValue"
) {
  // Only allow one request to shinemonitor at once
  while (requestBeingMade) {
    await requestBeingMade;
  }
  let resolveLock: VoidFunction;
  requestBeingMade = new Promise(resolve => (resolveLock = resolve));
  try {
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
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:144.0) Gecko/20100101 Firefox/144.0",
        "Accept-Language": "en-SE;q=1, sv-SE;q=0.9",
        "Accept": "*/*",
      },
    });

    if (!response.ok) {
      throw new Error("Failed to make request to shinemonitor, non-200 response: " + response.status);
    }
    const decoded = (await response.json()) as T;

    return decoded;
  } finally {
    requestBeingMade.then((requestBeingMade = undefined)); // In a .then to avoid race-condition where a new request is made before the result of resolving the promise has propagated and therefore two requests are made
    resolveLock!();
  }
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
    if (createdAt + expire * 1000 > +new Date()) {
      return saved.authApiReturn;
    }
  }
  return await loginToShinemonitor(configSignal);
}

async function loginToShinemonitor(configSignal: Awaited<ReturnType<typeof get_config_object>>) {
  logLog("Logging in to shinemonitor");
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
    sign: hashedConcatenated,
    salt: now + "",
    ...request,
  };
  const urlObject = new URL(shineUrl);
  urlObject.search = new URLSearchParams(finalQuery) + "";

  const response = await fetch(urlObject, {
    headers: {
      "User-Agent": "SolarPower/2.2.0 (iPad; iOS 26.0; Scale/2.00)",
      "Accept-Language": "en-SE;q=1, sv-SE;q=0.9",
      "Accept": "*/*",
    },
  });
  if (!response.ok) {
    throw new Error("Failed to login to shinemonitor, non-200 response: " + response.status);
  }

  const json = (await response.json()) as NonNullable<Config["savedAuth_do_not_edit"]>["authApiReturn"];

  if (json.err !== 0 || !json.dat) {
    logLog("Decoded", json);
    throw new Error("Failed to login to shinemonitor, error code: " + json.err + " desc: " + json.desc);
  }

  logLog("Login to shinemonitor succeeded");
  setConfig(prev => ({ ...prev, savedAuth_do_not_edit: { createdAt: now, authApiReturn: json } }));

  return json;
}
