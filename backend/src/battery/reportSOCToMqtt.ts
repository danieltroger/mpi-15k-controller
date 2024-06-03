import { Accessor, createEffect, Resource, untrack } from "solid-js";
import { AsyncMqttClient } from "async-mqtt";
import { Config } from "../config";

export function reportSOCToMqtt({
  mqttClient,
  config,
  averageSOC,
  socSinceEmpty,
  socSinceFull,
}: {
  mqttClient: Resource<AsyncMqttClient>;
  config: Accessor<Config>;
  averageSOC: Accessor<number | undefined>;
  socSinceFull: Accessor<number | undefined>;
  socSinceEmpty: Accessor<number | undefined>;
}) {
  createEffect(() => {
    const client = mqttClient();
    if (!client) return;

    createEffect(() => {
      const table = untrack(() => config().soc_calculations.table);
      const average = averageSOC();
      if (!average) return;
      const influx_entry = `${table} average_soc=${average}`;
      if (client.connected) {
        client.publish(table, influx_entry).catch(() => {});
      }
    });
    createEffect(() => {
      const table = untrack(() => config().soc_calculations.table);
      const sinceFull = socSinceFull();
      if (!sinceFull) return;
      const influx_entry = `${table} soc_since_full=${sinceFull}`;
      if (client.connected) {
        client.publish(table, influx_entry).catch(() => {});
      }
    });
    createEffect(() => {
      const table = untrack(() => config().soc_calculations.table);
      const sinceEmpty = socSinceEmpty();
      if (!sinceEmpty) return;
      const influx_entry = `${table} soc_since_empty=${sinceEmpty}`;
      if (client.connected) {
        client.publish(table, influx_entry).catch(() => {});
      }
    });
  });
}
