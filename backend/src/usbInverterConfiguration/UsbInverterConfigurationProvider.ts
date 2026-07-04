import { type Accessor, createContext, createSignal, type JSX, untrack, useContext } from "solid-js";
import type { Config } from "../config/config.types.ts";
import type { CommandQueue, UsbConfiguration } from "./usb.types.ts";
import { useGetUsbValues } from "./useGetUsbValues.ts";
import { useProcessUsbQueue } from "./useProcessUsbQueue.ts";

const UsbInverterConfigurationContext = createContext<UsbConfiguration>();

export function UsbInverterConfigurationProvider(props: { children: JSX.Element; config: Accessor<Config> }) {
  const [commandQueue, setCommandQueue] = createSignal<CommandQueue>(new Set());
  const { $usbValues, triggerGettingUsbValues } = useGetUsbValues({
    commandQueue,
    setCommandQueue,
    config: untrack(() => props.config),
  });

  return UsbInverterConfigurationContext.Provider({
    value: { commandQueue, setCommandQueue, $usbValues, triggerGettingUsbValues },
    get children() {
      useProcessUsbQueue(untrack(() => props.config));
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
