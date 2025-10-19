import MQTT from "async-mqtt";
import { Accessor, createEffect, createResource, createSignal, getOwner, onCleanup, runWithOwner } from "solid-js";
import { logLog, warnLog } from "../utilities/logging";
import { createStore } from "solid-js/store";
import { RawMQTTValues, validateMessage } from "./rawValuesSchema";

export function useMQTTValues(mqttHost: Accessor<string>) {
  const [reconnectToggle, setReconnectToggle] = createSignal(1); // Needs to be truthy or createResource won't fetch
  const [client] = createResource(
    () => [mqttHost(), reconnectToggle()] as const,
    async ([host]) => {
      const c = await MQTT.connectAsync("tcp://" + host);
      onCleanup(() => c.end());
      return c;
    }
  );
  const [subscription] = createResource(client, client => client.subscribe("#"));
  const [values, setValues] = createStore<
    Partial<{
      [key in keyof RawMQTTValues]: { value: RawMQTTValues[key]; time: number };
    }>
  >({});
  const owner = getOwner();

  createEffect(() => {
    const clientValue = client();
    if (!clientValue) return;
    let receivedFirstValue = false;
    logLog("We have MQTT client");
    clientValue.on("error", e => {
      logLog("MQTT error, re-starting connection in 2s", e);
      setTimeout(() => setReconnectToggle(t => (t === 1 ? 2 : 1)), 2000);
    });
    clientValue.on("connect", e => logLog("MQTT connected", e));
    clientValue.on("message", (topic, message) =>
      runWithOwner(owner, () => {
        if (topic == "mpp-solar") {
          const [topicInMsg, payload] = message.toString().split(",");
          const [commandString, ...keyValuePair] = payload.split(" ");
          const [key, value] = keyValuePair.join(" ").split("=");
          let parsed = value;
          if (!receivedFirstValue) {
            receivedFirstValue = true;
            logLog("Got first value for connection", key, value);
          }

          try {
            parsed = JSON.parse(value);
          } catch (e) {}
          try {
            validateMessage(key as keyof RawMQTTValues, parsed);
          } catch (e) {
            warnLog("Validation for MQTT message failed", e);
          }
          setValues(key as keyof RawMQTTValues, {
            value: parsed as RawMQTTValues[keyof RawMQTTValues],
            time: +new Date(),
          });
        }
      })
    );
  });
  createEffect(() => subscription() && logLog("We have MQTT subscription", subscription()));

  return { mqttValues: values, mqttClient: client };
}
