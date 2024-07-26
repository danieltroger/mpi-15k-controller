import { get_config_object } from "./config";
import { createEffect, createResource, createSignal, onCleanup, untrack } from "solid-js";
import { deparallelize_no_drop, wait } from "@depict-ai/utilishared/latest";
import { error, log } from "./utilities/logging";
import { GetVoltageResponse, makeRequestWithAuth, SetVoltageResponse } from "./shineMonitor";

const lastShineRequestForParameter: Record<string, number> = {};

/**
 * Generic utility that helps interfacing with a parameter on the inverter via shinemonitor.
 * Kinda duplicated with the code in prematureFloatBugWorkaround right now, although this one is more generic. Maybe can refactor in the future.
 */
export function useShinemonitorParameter<
  ReadParameterResponse extends string,
  WantedValueType extends string = string,
>({
  configSignal,
  parameter,
  wantedToCurrentTransformerForDiffing,
}: {
  parameter: string;
  configSignal: Awaited<ReturnType<typeof get_config_object>>;
  wantedToCurrentTransformerForDiffing: (WantedValueType: string) => ReadParameterResponse;
}) {
  const [wantedValue, setWantedValue] = createSignal<WantedValueType | undefined>();
  const [syncStateToggle, setSyncStateToggle] = createSignal(false);
  const [currentValue, { refetch }] = createResource(async () =>
    getConfiguredValueFromShinemonitor<ReadParameterResponse>(configSignal, parameter)
  );
  const refetchInterval = setInterval(refetch, 1000 * 60 * 10); // refetch every ten minutes so we diff against the latest value

  const deparallelizedSetValue = deparallelize_no_drop((value: WantedValueType) =>
    setParameterWithThrottlingAndRefetch(
      configSignal,
      parameter,
      // Use new value, even if there was a delay before setting (value here as fallback to satisfy typescript)
      () => wantedValue() || value,
      refetch,
      () => setSyncStateToggle(prev => !prev)
    )
  );
  createEffect(() => {
    syncStateToggle();
    const wanted = wantedValue();
    const current = currentValue();
    let wantedForDiffing: ReadParameterResponse | WantedValueType | undefined = wanted;
    if (wanted && wantedToCurrentTransformerForDiffing) {
      // The read endpoint returns "48" for "Disable" and "49" for "Enable" for some reason, but when setting we have to pass "48" or "49"
      wantedForDiffing = wantedToCurrentTransformerForDiffing(wanted);
    }
    if (!wantedForDiffing || !wanted || !current || wantedForDiffing === current) {
      return;
    }
    log(
      "Queueing request to set",
      parameter,
      "to",
      wanted,
      ". We think the inverter is configured to",
      current,
      "right now."
    );
    deparallelizedSetValue(wanted);
  });

  onCleanup(() => clearInterval(refetchInterval));

  return { wantedValue, setWantedValue, currentValue } as const;
}

async function setParameterWithThrottlingAndRefetch<T>(
  configSignal: Awaited<ReturnType<typeof get_config_object>>,
  parameter: string,
  value: () => string,
  refetch: (info?: unknown) => T | Promise<T | undefined> | null | undefined,
  callOnFailure: VoidFunction
) {
  const now = +new Date();
  const setMaxEvery = 40_000;
  const setAgo = now - (lastShineRequestForParameter[parameter] ?? 0);
  if (setAgo < setMaxEvery) {
    const waitFor = setMaxEvery - setAgo;
    log("Waiting with setting ", parameter, " for", waitFor, "ms, because it was set very recently");
    await new Promise(resolve => setTimeout(resolve, waitFor));
  }
  const didFail = await setConfiguredValueInShinemonitor(configSignal, parameter, value());
  lastShineRequestForParameter[parameter] = +new Date();
  await refetch();
  await wait(8000); // Inverter needs time for it to be set, so check again after 8s
  await refetch();
  if (didFail) {
    callOnFailure();
  }
}

async function getConfiguredValueFromShinemonitor<T>(
  configSignal: Awaited<ReturnType<typeof get_config_object>>,
  parameter: string
) {
  const [config] = configSignal;
  let result: GetVoltageResponse;
  try {
    result = await makeRequestWithAuth<GetVoltageResponse>(configSignal, {
      "sn": untrack(config).inverter_sn!,
      "pn": untrack(config).inverter_pn!,
      "id": parameter,
      "devcode": "2454",
      "i18n": "en_US",
      "devaddr": "1",
      "source": "1",
    });
  } catch (e) {
    // Very stupid retry logic because this keeps crashing feedWhenNoSolar
    /* [ERROR] 2024-07-26T14:24:06.004Z Feed when no solar errored TypeError: fetch failed
    at node:internal/deps/undici/undici:12500:13
    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)
    at async makeRequestWithAuth (file:///home/ubuntu/mpi-15k-controller/backend/src/shineMonitor.ts:37:26)
    at async getConfiguredValueFromShinemonitor (file:///home/ubuntu/mpi-15k-controller/backend/src/useShinemonitorParameter.ts:59:20) {
  [cause]: ConnectTimeoutError: Connect Timeout Error
      at onConnectTimeout (node:internal/deps/undici/undici:6621:28)
      at node:internal/deps/undici/undici:6573:50
      at Immediate._onImmediate (node:internal/deps/undici/undici:6605:13)
      at process.processImmediate (node:internal/timers:478:21)
      at process.callbackTrampoline (node:internal/async_hooks:130:17) {
    code: 'UND_ERR_CONNECT_TIMEOUT'
  }
} restarting in 60s */
    await new Promise(r => setTimeout(r, 1000));
    result = await makeRequestWithAuth<GetVoltageResponse>(configSignal, {
      "sn": untrack(config).inverter_sn!,
      "pn": untrack(config).inverter_pn!,
      "id": parameter,
      "devcode": "2454",
      "i18n": "en_US",
      "devaddr": "1",
      "source": "1",
    });
  }
  if (result.err || result.dat.id !== parameter + "_read") {
    error(`Failed to get ${parameter} from shinemonitor`, result, "expected id to be");
    throw new Error("Failed to get parameter value from shinemonitor (" + parameter + ")");
  }
  return result.dat.val as T;
}

async function setConfiguredValueInShinemonitor(
  configSignal: Awaited<ReturnType<typeof get_config_object>>,
  parameter: string,
  value: string
) {
  const [config] = configSignal;
  let result: SetVoltageResponse;
  try {
    result = await makeRequestWithAuth<SetVoltageResponse>(
      configSignal,
      {
        "sn": untrack(config).inverter_sn!,
        "id": parameter,
        "pn": untrack(config).inverter_pn!,
        "devcode": "2454",
        "val": value,
        "devaddr": "1",
      },
      "ctrlDevice"
    );
  } catch (e) {
    error("Failed to set", parameter, "to", value, "in shinemonitor", e);
    return true;
  }
  if (result.err) {
    error("Failed to set", parameter, "to", value, "in shinemonitor", result);
    return true;
  }
  log("Successfully set", parameter, " in shinemonitor to", value, result);
}
