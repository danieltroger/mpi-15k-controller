import type Influx from "influx";
import { get_config_object } from "../config/config.ts";
import { type Accessor, createEffect, createMemo, createResource } from "solid-js";
import { errorLog, logLog } from "../utilities/logging.ts";
import { useInfluxClient } from "../utilities/InfluxClientProvider.ts";

export function useDatabasePower([config]: Awaited<ReturnType<typeof get_config_object>>) {
  const influxClient = useInfluxClient();
  createEffect(() => {
    if (!influxClient()) {
      errorLog(
        "No influxdb config found (or incomplete), please configure influxdb.host, influxdb.database, influxdb.username and influxdb.password in config.json"
      );
    }
  });

  const fullWhenAccessor = createMemo(() => config().full_battery_voltage);

  const [batteryWasLastFullAt] = createResource(
    () => [influxClient(), fullWhenAccessor()] as const,
    async ([db, fullWhen]) => {
      if (!db) return;
      logLog("Getting last full time from database");
      const [response] = await db.query(
        `SELECT last("battery_voltage") FROM "mpp-solar" WHERE "battery_voltage" >= ${fullWhen}`
      );
      let timeOfLastFull = (response as { time?: { getNanoTime: () => number } })?.time?.getNanoTime?.();
      if (timeOfLastFull !== undefined && !isNaN(timeOfLastFull)) {
        const when = Math.round(timeOfLastFull / 1000 / 1000);
        logLog("Got from database that battery was last full at ", new Date(when).toISOString());
        return when;
      }
    }
  );
  const emptyAtAccessor = createMemo(() => config().soc_calculations.battery_empty_at);
  const [batteryWasLastEmptyAt] = createResource(
    () => [influxClient(), emptyAtAccessor()] as const,
    async ([db, emptyAt]) => {
      if (!db) return;
      const [response] = await db.query(
        `SELECT last("battery_voltage") FROM "mpp-solar" WHERE ("battery_voltage" <= ${emptyAt} OR "battery_voltage" = ${emptyAt * 10}) AND "battery_voltage" > 0`
      );
      let timeOfLastEmpty = (response as { time?: { getNanoTime: () => number } })?.time?.getNanoTime?.();
      if (timeOfLastEmpty !== undefined && !isNaN(timeOfLastEmpty)) {
        const when = Math.round(timeOfLastEmpty / 1000 / 1000);
        logLog("Got from database that battery was last empty at ", new Date(when).toISOString());
        return when;
      }
    }
  );

  return {
    batteryWasLastFullAtAccordingToDatabase: batteryWasLastFullAt,
    batteryWasLastEmptyAtAccordingToDatabase: batteryWasLastEmptyAt,
    influxClient,
  };
}

export type InfluxClientAccessor = Accessor<Influx.InfluxDB | undefined>;
