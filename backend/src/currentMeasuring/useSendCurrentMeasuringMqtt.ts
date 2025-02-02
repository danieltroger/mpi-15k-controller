import { temperature_reader, ThermometerValue } from "./temperature_reader";
import { Accessor, createComputed, createMemo, For, untrack } from "solid-js";
import { error, log } from "./helpers/logging";
import { Config } from "./config";
import { promises as fs } from "fs";
import path from "path";
import process from "process";
import mqtt from "mqtt";

const DATABASE = "mppsolar";
const TARGET = "192.168.1.106"; // target for mqtt
const TABLE = "frendebo_thermometers";
const database_import_file_header = `# DML
# CONTEXT-DATABASE: ${DATABASE}
# CONTEXT-RETENTION-POLICY: autogen
`;

export function useSendCurrentMeasuringMqtt({
  temperatures,
  get_config,
}: {
  temperatures: ReturnType<typeof temperature_reader>;
  get_config: Accessor<Config>;
}) {
  const mqtt_client = mqtt.connect("mqtt://" + TARGET);
  // Write weighted average of temperatures every ~3s to a file to import into influx once MacMini is running again with Grafana and stuff
  const local_storage_file_name = path.dirname(process.argv[1]) + "/../for_influx.txt";
  log("Using", local_storage_file_name, "as local log for temperatures");
  const file_handle = fs
    .open(local_storage_file_name, "a+")
    .catch(e => error("Couldn't open local temperature log file", e));

  const keys = createMemo(() => Object.keys(temperatures()));
  For({
    get each() {
      return keys();
    },
    children: key => {
      const value_accessor = temperatures()[key];
      const values = new Set<ThermometerValue>();
      let values_start = +new Date();

      createComputed(() => {
        const thermometer_object = value_accessor();
        if (!thermometer_object) return; // Unsure if this can happen but just in case
        values.add(thermometer_object);
        const now = +new Date();
        if (now - values_start >= untrack(get_config).temperature_report_interval) {
          const weighted_average = calculate_weighted_average({ values, now });
          if (!isNaN(weighted_average)) {
            // Don't report NaN averages when we got no data for a longer period
            report_value({
              averaged_value: weighted_average,
              label: thermometer_object.label,
              time: now,
              file_handle,
              mqtt_client,
            }).catch(e => error("Couldn't write averaged temperature value to log/mqtt", e));
          }
          values_start = now;
        }
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
  mqtt_client,
}: {
  averaged_value: number;
  label: string;
  time: number;
  file_handle: Promise<void | fs.FileHandle>;
  mqtt_client: mqtt.MqttClient;
}) {
  const influx_entry = `${TABLE} ${label}=${averaged_value}`;
  if (mqtt_client.connected) {
    try {
      mqtt_client.publish(TABLE, influx_entry);
      return;
    } catch (e) {
      // error("Couldn't publish mqtt message", e, "saving offline");
    }
  }
  const handle = await file_handle;
  if (!handle) return;
  const buf = Buffer.alloc(database_import_file_header.length);
  await handle.read(buf, 0, database_import_file_header.length, 0);
  const current_header_of_file = String(buf);
  if (current_header_of_file !== database_import_file_header) {
    await handle.write(database_import_file_header);
  }
  await handle.write(`${influx_entry} ${Math.round(time / 1000)}\n`);
}

function calculate_weighted_average({ values, now }: { values: Set<ThermometerValue>; now: number }) {
  const values_as_array = [...values];
  let weighted_sum = 0;
  let duration_sum = 0;
  for (let i = 0; i < values_as_array.length; i++) {
    const this_value = values_as_array[i];
    const next_value = values_as_array[i + 1] as ThermometerValue | undefined;
    const duration_of_value = (next_value?.time ?? now) - this_value.time;
    weighted_sum += duration_of_value * this_value.value;
    duration_sum += duration_of_value;
  }
  values.clear();
  const weighted_average = weighted_sum / duration_sum;
  return weighted_average;
}
