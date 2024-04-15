import MQTT from "async-mqtt";
import { createEffect, createResource, createSignal, getOwner, onCleanup, runWithOwner } from "solid-js";
import { log } from "./logging";
import { createStore } from "solid-js/store";

export function useMQTTValues() {
  const [reconnectToggle, setReconnectToggle] = createSignal(1); // Needs to be truthy or createResource won't fetch
  const [client] = createResource(reconnectToggle, async () => {
    const c = await MQTT.connectAsync("tcp://192.168.0.3");
    onCleanup(() => c.end());
    return c;
  });
  const [subscription] = createResource(client, client => client.subscribe("#"));
  const [values, setValues] = createStore<Record<string, undefined | { time: number; value: string | number }>>({});
  const owner = getOwner();

  createEffect(() => {
    const clientValue = client();
    if (!clientValue) return;
    let receivedFirstValue = false;
    log("We have MQTT client");
    clientValue.on("error", e => {
      log("MQTT error, re-starting connection in 2s", e);
      setTimeout(() => setReconnectToggle(t => (t === 1 ? 2 : 1)), 2000);
    });
    clientValue.on("connect", e => log("MQTT connected", e));
    clientValue.on("message", (topic, message) =>
      runWithOwner(owner, () => {
        if (topic == "mpp-solar") {
          const [topic_in_msg, payload] = message.toString().split(",");
          const [command_str, key_value_pair] = payload.split(" ");
          const [key, value] = key_value_pair.split("=");
          let parsed = value;
          if (!receivedFirstValue) {
            receivedFirstValue = true;
            log("Got first value for connection", key, value);
          }

          try {
            parsed = JSON.parse(value);
          } catch (e) {}
          setValues(key, { value: parsed, time: Date.now() });
        }
      })
    );
  });
  createEffect(() => subscription() && log("We have MQTT subscription", subscription()));

  return values;
}
