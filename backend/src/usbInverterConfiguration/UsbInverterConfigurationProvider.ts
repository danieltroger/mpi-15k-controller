import { Accessor, createContext, createMemo, createSignal, JSX, Setter, useContext } from "solid-js";
import { Config } from "../config.types";

type USBCommands =
  // Only added the ones I currently need, see jblance mpp-solar documentation for more
  /**
   * Enable/disable AC charge battery
   */
  | { command: "EDB"; value: boolean }
  /**
   * Enable/disable battery discharge to feed power to utility when solar input normal
   */
  | { command: "EDF"; value: boolean }
  /**
   * Enable/disable battery discharge to feed power to utility when solar input loss
   */
  | { command: "EDG"; value: boolean }
  /**
   * Set max power of feeding grid
   */
  | { command: "GPMP0"; value: number }
  /**
   * Query the maximum output power for feeding grid -- queries Query the maximum output power for feeding grid
   */
  | { command: "GPMP" }
  /**
   * Query energy control status -- queries the device energy distribution
   */
  | { command: "HECS" };

type CommandQueue = (USBCommands & { onResult: (result: string) => void })[];

type UsbConfiguration = {
  commandQueue: Accessor<CommandQueue>;
  setCommandQueue: Setter<CommandQueue>;
};

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
