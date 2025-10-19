import { Accessor, createComputed, createMemo, For, Resource, untrack } from "solid-js";
import { promises as fs } from "fs";
import path from "path";
import process from "process";
import { useTemperatures } from "./useTemperatures";
import { errorLog, logLog } from "../utilities/logging";
import MQTT from "async-mqtt";
import { useFromMqttProvider } from "../mqttValues/MQTTValuesProvider";
import { Config } from "../config/config.types";

export function saveTemperatures({
  temperatures,
  config,
}: {
  temperatures: ReturnType<typeof useTemperatures>;
  config: Accessor<Config>;
}) {
  // Write weighted average of temperatures every ~3s to a file to import into influx once MacMini is running again with Grafana and stuff
  const local_storage_file_name = path.dirname(process.argv[1]) + "/../for_influx.txt";
  logLog("Using", local_storage_file_name, "as local log for temperatures");
  const file_handle = fs
    .open(local_storage_file_name, "a+")
    .catch(e => errorLog("Couldn't open local temperature log file", e));

  const keys = createMemo(() => Object.keys(temperatures()));
  For({
    get each() {
      return keys();
    },
    children: key => {
      const value_accessor = temperatures()[key];

      createComputed(() => {
        const thermometer_object = value_accessor();
        const { mqttClient } = useFromMqttProvider();
        if (!thermometer_object) return; // Unsure if this can happen but just in case
        report_value({
          averaged_value: thermometer_object.value,
          label: thermometer_object.label,
          time: thermometer_object.time,
          file_handle,
          mqttClient,
          table: untrack(config).temperature_saving.table,
          database: untrack(config).temperature_saving.database,
        }).catch(e => errorLog("Couldn't write averaged temperature value to log/mqtt", e));
      });

      return undefined;
    },
  });
}

async function report_value({
  averaged_value,
  label,
  time,
  file_handle,
  mqttClient,
  database,
  table,
}: {
  averaged_value: number;
  label: string;
  time: number;
  file_handle: Promise<void | fs.FileHandle>;
  mqttClient: Resource<MQTT.AsyncMqttClient>;
  table: string;
  database: string;
}) {
  const database_import_file_header = `# DML
# CONTEXT-DATABASE: ${database}
# CONTEXT-RETENTION-POLICY: autogen
`;
  const mqtt_client = untrack(mqttClient);
  const influx_entry = `${table} ${label}=${averaged_value}`;
  if (mqtt_client?.connected) {
    try {
      await mqtt_client.publish(table, influx_entry);
      return;
    } catch (e) {
      // error("Couldn't publish mqtt message", e, "saving offline");
    }
  }
  const handle = await file_handle;
  if (!handle) return;
  const buf = new Uint8Array(database_import_file_header.length);
  await handle.read(buf, 0, database_import_file_header.length, 0);
  const current_header_of_file = new TextDecoder().decode(buf);
  if (current_header_of_file !== database_import_file_header) {
    await handle.write(database_import_file_header);
  }
  await handle.write(`${influx_entry} ${Math.round(time / 1000)}\n`);
}
