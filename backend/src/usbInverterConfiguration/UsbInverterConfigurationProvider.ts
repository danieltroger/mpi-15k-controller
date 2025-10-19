import {
  Accessor,
  createContext,
  createEffect,
  createMemo,
  createSignal,
  JSX,
  Setter,
  untrack,
  useContext,
} from "solid-js";
import { Config } from "../config/config.types";
import { CommandQueue, UsbConfiguration } from "./usb.types";
import { debugLog } from "../utilities/logging";
import { exec } from "../utilities/exec";
import { useGetUsbValues } from "./useGetUsbValues";

const UsbInverterConfigurationContext = createContext<UsbConfiguration>();

export function UsbInverterConfigurationProvider(props: { children: JSX.Element; config: Accessor<Config> }) {
  const [commandQueue, setCommandQueue] = createSignal<CommandQueue>([]);
  const usbValues = useGetUsbValues({ commandQueue, setCommandQueue, config: untrack(() => props.config) });

  return UsbInverterConfigurationContext.Provider({
    value: { commandQueue, setCommandQueue },
    get children() {
      useHandleUsbQueue(untrack(() => props.config));
      return props.children;
    },
  });
}

function useHandleUsbQueue(config: Accessor<Config>) {
  const { commandQueue, setCommandQueue } = useUsbInverterConfiguration();
  const minSecondsBetweenCommands = createMemo(() => config().usb_parameter_setting.min_seconds_between_commands);

  createEffect(() => {});
}

export function useUsbInverterConfiguration() {
  const contextValue = useContext(UsbInverterConfigurationContext);
  if (!contextValue) {
    throw new Error("useUsbInverterConfiguration must be used within a UsbInverterConfigurationProvider");
  }
  return contextValue;
}

async function sendUsbCommands({
  commandQueue,
  setCommandQueue,
}: {
  commandQueue: Accessor<CommandQueue>;
  setCommandQueue: Setter<CommandQueue>;
}) {
  debugLog("Turning off MQTT value reading daemon");
  const { stdout: disableStdout, stderr: disableStderr } = await exec("systemctl --user stop mpp-solar");
  debugLog("Turned off MQTT value reading daemon", { disableStdout, disableStderr });

  debugLog("beginning setting charging current to", targetDeciAmperes, "deci amperes");
  const { stdout, stderr } = await exec(
    `mpp-solar -p /dev/hidraw0 -P PI17  -c MUCHGC${(targetDeciAmperes + "").padStart(4, "0")}`
  );
  debugLog("Set wanted charging current", { stdout, stderr });
}
