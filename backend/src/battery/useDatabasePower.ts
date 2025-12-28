import Influx from "influx";
import { get_config_object } from "../config/config";
import { Accessor, createMemo, createResource } from "solid-js";
import { errorLog, logLog } from "../utilities/logging";

export function useDatabasePower([config]: Awaited<ReturnType<typeof get_config_object>>) {
  const host = createMemo(() => config()?.influxdb?.host);
  const database = createMemo(() => config()?.influxdb?.database);
  const username = createMemo(() => config()?.influxdb?.username);
  const password = createMemo(() => config()?.influxdb?.password);
  const influxClient = createMemo(() => {
    if (!host() || !database() || !username() || !password()) {
      errorLog(
        "No influxdb config found (or incomplete), please configure influxdb.host, influxdb.database, influxdb.username and influxdb.password in config.json"
      );
      return;
    }

    return new Influx.InfluxDB({
      "host": host(),
      "database": database(),
      "username": username(),
      "password": password(),
    });
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

/**
 * Query InfluxDB for the integral of calculated_power from a given start time to now.
 * Returns energy in watt-hours.
 */
export async function queryEnergyIntegral(db: Influx.InfluxDB, fromMs: number) {
  // integral() with 1h unit directly gives us watt-hours
  // We query from (fromMs + 1) to avoid including the exact "full" or "empty" moment
  const query = `SELECT integral("calculated_power", 1h) as energy FROM "current_values" WHERE time >= ${fromMs + 1}ms`;
  logLog("Querying energy integral from", new Date(fromMs).toISOString());

  const results = await db.query<{ energy: number | null }>(query);
  const energy = results[0]?.energy;

  if (energy != null && !isNaN(energy)) {
    logLog("Got energy integral:", energy, "Wh from", new Date(fromMs).toISOString());
    return energy;
  }

  logLog("No energy data found from", new Date(fromMs).toISOString());
  // We don't have any energy data (yet) when the battery just got full - return 0 since that's most likely the right answer
  return 0;
}

export type InfluxClientAccessor = Accessor<Influx.InfluxDB | undefined>;
