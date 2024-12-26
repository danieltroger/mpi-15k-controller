import { Accessor, createContext, JSX, useContext } from "solid-js";
import { useMQTTValues } from "../mqttValues/useMQTTValues";

const MqttValuesContext = createContext<ReturnType<typeof useMQTTValues>>();

export function MQTTValuesProvider(props: { children?: JSX.Element; mqttHost: Accessor<string> }) {
  return MqttValuesContext.Provider({
    value: useMQTTValues(() => props.mqttHost()),
    get children() {
      return props.children;
    },
  });
}

export function useFromMqttProvider() {
  const contextValue = useContext(MqttValuesContext);
  if (!contextValue) {
    throw new Error("useFromMqttProvider must be used within a MQTTValuesProvider");
  }
  return contextValue;
}
