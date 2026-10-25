/**
 * Historically this subscribed to the mpp-solar daemon's MQTT topic and parsed our own inverter
 * telemetry back out of the broker (a silly ts→mqtt→ts loop). The values now come straight from
 * the native serial decoder (inverterComms) — same store shape, same field names, same per-key
 * timestamps, so every consumer including the staleness alerting is unchanged. The MQTT client
 * itself remains: the backend still PUBLISHES to the broker (inverter values for telegraf →
 * InfluxDB via publishInverterRoundsToMqtt, plus temperatures/SOC/current measurements elsewhere).
 */
import MQTT from "async-mqtt";
import { type Accessor, createEffect, createResource, createSignal, onCleanup } from "solid-js";
import { logLog } from "../utilities/logging.ts";
import { useInverterComms } from "../inverterComms/InverterCommsProvider.ts";
import { publishInverterRoundsToMqtt } from "../inverterComms/publishInverterRoundsToMqtt.ts";

export function useMQTTValues(mqttHost: Accessor<string>) {
  const { inverterValues, lastDecodedRound } = useInverterComms();
  const [reconnectToggle, setReconnectToggle] = createSignal(1); // Needs to be truthy or createResource won't fetch
  const [client] = createResource(
    () => [mqttHost(), reconnectToggle()] as const,
    async ([host]) => {
      const c = await MQTT.connectAsync("tcp://" + host);
      onCleanup(() => c.end());
      return c;
    }
  );

  createEffect(() => {
    const clientValue = client();
    if (!clientValue) return;
    logLog("We have MQTT client");
    clientValue.on("error", e => {
      logLog("MQTT error, re-starting connection in 2s", e);
      setTimeout(() => setReconnectToggle(t => (t === 1 ? 2 : 1)), 2000);
    });
    clientValue.on("connect", e => logLog("MQTT connected", e));
  });

  publishInverterRoundsToMqtt({ mqttClient: client, lastDecodedRound });

  return { mqttValues: inverterValues, mqttClient: client };
}
