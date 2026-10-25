/**
 * Context provider for the native PI17 serial engine — the single owner of the inverter serial
 * session. Everything that used to come from parsing our own mpp-solar MQTT traffic back
 * (mqttValues) or from spawning the mpp-solar CLI ($usbValues, control writes) comes from here.
 */
import { type Accessor, createContext, type JSX, untrack, useContext } from "solid-js";
import type { Config } from "../config/config.types.ts";
import { useInverterValues } from "./useInverterValues.ts";

const InverterCommsContext = createContext<ReturnType<typeof useInverterValues>>();

export function InverterCommsProvider(props: { children: JSX.Element; config: Accessor<Config> }) {
  return InverterCommsContext.Provider({
    value: useInverterValues(untrack(() => props.config)),
    get children() {
      return props.children;
    },
  });
}

export function useInverterComms() {
  const contextValue = useContext(InverterCommsContext);
  if (!contextValue) {
    throw new Error("useInverterComms must be used within an InverterCommsProvider");
  }
  return contextValue;
}
