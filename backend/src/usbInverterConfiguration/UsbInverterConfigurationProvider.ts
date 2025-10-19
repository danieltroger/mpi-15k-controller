import { Accessor, createContext, createMemo, createSignal, JSX, Setter, useContext } from "solid-js";
import { Config } from "../config/config.types";
import { CommandQueue, UsbConfiguration } from "./usb.types";
import { debugLog, errorLog } from "../utilities/logging";
import { exec } from "../utilities/exec";

const UsbInverterConfigurationContext = createContext<UsbConfiguration>();

export function UsbInverterConfigurationProvider(props: { children: JSX.Element; config: Accessor<Config> }) {
  const minSecondsBetweenCommands = createMemo(() => props.config().usb_parameter_setting.min_seconds_between_commands);
  const pollValuesIntervalSeconds = createMemo(() => props.config().usb_parameter_setting.poll_values_interval_seconds);

  const [commandQueue, setCommandQueue] = createSignal<CommandQueue>([]);
  return UsbInverterConfigurationContext.Provider({
    value: { commandQueue, setCommandQueue },
    get children() {
      return props.children;
    },
  });
}

export function useUsbInverterConfiguration() {
  const contextValue = useContext(UsbInverterConfigurationContext);
  if (!contextValue) {
    throw new Error("useUsbInverterConfiguration must be used within a UsbInverterConfigurationProvider");
  }
  return contextValue;
}

function useGetUsbValues({
  commandQueue,
  setCommandQueue,
}: {
  commandQueue: Accessor<CommandQueue>;
  setCommandQueue: Setter<CommandQueue>;
}) {}

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
