import { get_config_object } from "./config/config.ts";
import { untrack } from "solid-js";
import { sha1 } from "./utilities/sha1.ts";
import { logLog, warnLog } from "./utilities/logging.ts";
import { wait } from "./vendor/depictUtilishared.ts";
import type { Config } from "./config/config.types.ts";

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
const TRANSIENT_RETRIES = 2;
const RETRY_DELAY_MS = 8_000;

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
    const requestPart = { action, source: "1", ...initialRequest };
    // Signed fresh per attempt — the salt is a timestamp and retries come seconds later
    const buildUrl = () => {
      const now = +new Date();
      const asQueryString = new URLSearchParams(requestPart) + "";
      const sign = sha1(now + secret + token + "&" + asQueryString);
      const urlObject = new URL(shineUrl);
      urlObject.search = new URLSearchParams({ sign: sign, salt: now + "", token: token, ...requestPart }) + "";
      return urlObject;
    };

    // Dessmonitor's cloud intermittently 404s or drops single requests and recovers within
    // seconds (139 log occurrences May–Jul 2026, every one self-healed). Absorb those blips here
    // instead of letting every consumer crash-restart and page a P2; a persistent outage still
    // throws after the retries.
    let response: Response | undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        response = await fetch(buildUrl(), {
          headers: {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:144.0) Gecko/20100101 Firefox/144.0",
            "Accept-Language": "en-SE;q=1, sv-SE;q=0.9",
            "Accept": "*/*",
          },
          signal: AbortSignal.timeout(120_000),
        });
      } catch (fetchError) {
        if (attempt >= TRANSIENT_RETRIES) throw fetchError;
        warnLog(
          `Shinemonitor request failed (${fetchError}), retry ${attempt + 1}/${TRANSIENT_RETRIES} in ${RETRY_DELAY_MS / 1000}s`
        );
        await wait(RETRY_DELAY_MS);
        continue;
      }
      if (response.ok) break;
      if (attempt >= TRANSIENT_RETRIES) {
        throw new Error("Failed to make request to shinemonitor, non-200 response: " + response.status);
      }
      warnLog(
        `Shinemonitor returned ${response.status}, retry ${attempt + 1}/${TRANSIENT_RETRIES} in ${RETRY_DELAY_MS / 1000}s`
      );
      await wait(RETRY_DELAY_MS);
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
    signal: AbortSignal.timeout(120_000),
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
