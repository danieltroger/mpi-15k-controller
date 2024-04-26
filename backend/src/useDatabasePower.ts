import Influx, { IResults } from "influx";
import { get_config_object } from "./config";
import { createMemo, createResource } from "solid-js";
import { error, log } from "./logging";
import { useNow } from "./useNow";

export function useDatabasePower([config]: Awaited<ReturnType<typeof get_config_object>>) {
  const currentTime = useNow();
  const influxClient = createMemo(() => {
    const configValue = config();
    if (!configValue.influxdb) {
      error(
        "No influxdb config found, please configure influxdb.host, influxdb.database, influxdb.username and influxdb.password in config.json"
      );
      return;
    }

    return new Influx.InfluxDB({
      "host": configValue.influxdb.host,
      "database": configValue.influxdb.database,
      "username": configValue.influxdb.username,
      "password": configValue.influxdb.password,
    });
  });
  const lastTimeItWasMidnight = createMemo(() => {
    const currentTimeValue = currentTime();
    const date = new Date(currentTimeValue);
    date.setHours(0, 0, 0, 0);
    return +date;
  });

  const [batteryWasLastFullAt] = createResource(influxClient, async db => {
    log("Getting last full time from database");
    const [response] = await db.query(
      `SELECT last("battery_voltage") FROM "mpp-solar" WHERE "battery_voltage" >= 584 AND "battery_current" < 100`
    );
    let timeOfLastFull = (response as any)?.time?.getNanoTime?.();
    if (!isNaN(timeOfLastFull)) {
      const when = Math.round(timeOfLastFull / 1000 / 1000);
      log("Got from database that battery was last full at ", new Date(when).toLocaleString());
      return when;
    }
  });

  const requestStartingAt = createMemo(() => {
    if (batteryWasLastFullAt.loading) return; // Wait for it to load before making any decision
    const lastFull = batteryWasLastFullAt();
    const previousMidnight = lastTimeItWasMidnight();
    if (lastFull) {
      return Math.min(previousMidnight, lastFull);
    }
    return previousMidnight;
  });

  const [interestingDatabaseValues] = createResource(
    () => [influxClient(), requestStartingAt()] as const,
    async ([db, startingAt]) => {
      if (!db || !startingAt) return;
      log("Requesting historic battery values from database");
      const result = await queryVoltageAndCurrentBetweenTimes(db, startingAt, +new Date());
      log("Got historic battery values from database");
      return result;
    }
  );

  const powerValues = createMemo(() => {
    const values = interestingDatabaseValues();
    if (!values) return [];
    const voltages = values.filter(value => value.battery_voltage !== null);
    const currents = values.filter(value => value.battery_current !== null);
    const multiplied = voltages.map((voltage, index) => {
      const { battery_current } = currents[index] || {};
      const { battery_voltage, time } = voltage;
      if (battery_voltage == null || battery_current == null) return;
      return {
        time: Math.round(time.getNanoTime() / 1000 / 1000),
        value: (battery_voltage / 10) * (battery_current / 10),
      };
    });
    return multiplied.filter(v => v != undefined) as { time: number; value: number }[];
  });

  return { batteryWasLastFullAtAccordingToDatabase: batteryWasLastFullAt, databasePowerValues: powerValues };
}

async function queryVoltageAndCurrentBetweenTimes(db: Influx.InfluxDB, start: number, end: number) {
  const twentyFourHours = 1000 * 60 * 60 * 24;
  const results: IResults<{
    battery_voltage: number | null;
    battery_current: number | null;
    time: { getNanoTime: () => number };
  }>[] = [];
  let localStart = start + 1;
  let localEnd = localStart + twentyFourHours + 1;

  while (localStart < end) {
    results.push(
      await db.query(
        `SELECT battery_voltage, battery_current FROM "mpp-solar" WHERE time >= ${localStart - 1}ms AND time <= ${localEnd}ms fill(null)`
      )
    );
    localStart = localEnd;
    if (localEnd + twentyFourHours > end) {
      localEnd = end;
    } else {
      localEnd += twentyFourHours + 1;
    }
  }
  return results.flat();
}
