import { Accessor, createContext, createSignal, JSX, untrack, useContext } from "solid-js";
import { Config } from "../config/config.types";
import { CommandQueue, UsbConfiguration } from "./usb.types";
import { useGetUsbValues } from "./useGetUsbValues";
import { useHandleUsbQueue } from "./useHandleUsbQueue";

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
      useHandleUsbQueue(untrack(() => props.config));
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
