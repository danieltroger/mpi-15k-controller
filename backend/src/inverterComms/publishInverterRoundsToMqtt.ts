/**
 * One-way MQTT feed for telegraf → InfluxDB — byte-for-byte what mpp-solar's influx2_mqtt output
 * published (topic `mpp-solar`, one Influx line-protocol message per field, tag `command=Inverter1`),
 * so telegraf config and Grafana dashboards need zero changes. The backend does NOT consume these
 * messages anymore — its own reactivity is fed directly from the serial decoder.
 */
import type MQTT from "async-mqtt";
import { createEffect, type Accessor, type Resource } from "solid-js";
import { warnLog } from "../utilities/logging.ts";
import type { DecodedFieldValue, DecodedRound } from "./pi17Protocol.types.ts";

export const INVERTER_MEASUREMENT_TOPIC = "mpp-solar";
/** The device name the retired mpp-solar daemon config used — the `command` tag of every Influx series */
export const INFLUX_DEVICE_TAG = "Inverter1";

export function publishInverterRoundsToMqtt({
  mqttClient,
  lastDecodedRound,
}: {
  mqttClient: Resource<MQTT.AsyncMqttClient>;
  lastDecodedRound: Accessor<DecodedRound | undefined>;
}) {
  createEffect(() => {
    const round = lastDecodedRound();
    const client = mqttClient();
    if (!round || !client) return;
    // The old daemon polled (and therefore published) GS#PS only — keep the Influx series set identical
    if (round.command !== "GS" && round.command !== "PS") return;
    for (const [fieldName, value] of Object.entries(round.fields)) {
      client
        .publish(INVERTER_MEASUREMENT_TOPIC, influxLineForField(fieldName, value))
        .catch(publishError => warnLog("Failed to publish inverter value", fieldName, "to MQTT", publishError));
    }
  });
}

/**
 * Live broker sample this replicates: `mpp-solar,command=Inverter1 solar_input_voltage_1=321.6`.
 * Strings are quoted, numbers bare (bare numbers without an `i` suffix are Influx floats — same
 * typing mpp-solar produced). No escaping, exactly like the reference implementation.
 */
export function influxLineForField(fieldName: string, value: DecodedFieldValue): string {
  const formattedValue = typeof value === "number" ? String(value) : `"${value}"`;
  return `${INVERTER_MEASUREMENT_TOPIC},command=${INFLUX_DEVICE_TAG} ${fieldName}=${formattedValue}`;
}
