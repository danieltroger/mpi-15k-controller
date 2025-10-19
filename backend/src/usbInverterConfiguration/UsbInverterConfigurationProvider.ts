import { Accessor, createContext, createMemo, createSignal, JSX, Setter, useContext } from "solid-js";
import { Config } from "../config.types";
import { CommandQueue, UsbConfiguration } from "./usb.types";

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

function useGetUsbValues({}: { commandQueue: Accessor<CommandQueue>; setCommandQueue: Setter<CommandQueue> }) {}

async function sendUsbCommands(commands: CommandQueue) {
  try {
    debugLog("beginning setting charging current to", targetDeciAmperes, "deci amperes");
    const { stdout, stderr } = await exec(
      `mpp-solar -p /dev/hidraw0 -P PI17  -c MUCHGC${(targetDeciAmperes + "").padStart(4, "0")}`
    );
    debugLog("Set wanted charging current", { stdout, stderr });
  } catch (e) {
    error("Setting wanted charging current failed", e);
  }
}
