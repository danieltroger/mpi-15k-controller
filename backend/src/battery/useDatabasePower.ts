import Influx, { IResults } from "influx";
import { get_config_object } from "../config";
import { createMemo, createResource } from "solid-js";
import { errorLog, logLog } from "../utilities/logging";
import { useNow } from "../utilities/useNow";

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
  const lastTimeItWasMidnight = createMemo(() => {
    const currentTime = useNow();
    const date = new Date(currentTime);
    date.setHours(0, 0, 0, 0);
    return +date;
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
      let timeOfLastFull = (response as any)?.time?.getNanoTime?.();
      if (!isNaN(timeOfLastFull)) {
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
        `SELECT last("battery_voltage") FROM "mpp-solar" WHERE "battery_voltage" <= ${emptyAt} AND "battery_voltage" > 0`
      );
      let timeOfLastEmpty = (response as any)?.time?.getNanoTime?.();
      if (!isNaN(timeOfLastEmpty)) {
        const when = Math.round(timeOfLastEmpty / 1000 / 1000);
        logLog("Got from database that battery was last empty at ", new Date(when).toISOString());
        return when;
      }
    }
  );

  const requestStartingAt = createMemo(() => {
    if (batteryWasLastFullAt.loading || batteryWasLastEmptyAt.loading) return; // Wait for it to load before making any decision
    const lastFull = batteryWasLastFullAt();
    const lastEmpty = batteryWasLastEmptyAt();
    const previousMidnight = lastTimeItWasMidnight();
    return Math.min(previousMidnight, lastFull || Infinity, lastEmpty || Infinity);
  });

  const [powerValues] = createResource(
    () => [influxClient(), requestStartingAt()] as const,
    async ([db, startingAt]) => {
      if (!db || !startingAt) return;
      logLog("Requesting historic battery power from database");
      const values = await queryCalculatedPowerBetweenTimes(db, startingAt, +new Date());
      logLog("Got historic battery power from database");

      const output: { time: number; value: number }[] = [];

      for (const item of values) {
        const { calculated_power, time } = item;
        if (calculated_power == null) continue;
        const finalTime = Math.round(time.getNanoTime() / 1000 / 1000);

        output.push({
          time: finalTime,
          value: calculated_power,
        });
      }

      // Sort by time
      output.sort((a, b) => a.time - b.time);
      return output;
    }
  );

  return {
    batteryWasLastFullAtAccordingToDatabase: batteryWasLastFullAt,
    databasePowerValues: powerValues,
    batteryWasLastEmptyAtAccordingToDatabase: batteryWasLastEmptyAt,
  };
}

async function queryCalculatedPowerBetweenTimes(db: Influx.InfluxDB, start: number, end: number) {
  const twentyFourHours = 1000 * 60 * 60 * 24;
  const results: IResults<{
    calculated_power: number | null;
    time: { getNanoTime: () => number };
  }>[] = [];
  let localStart = start + 1;
  let localEnd = localStart + twentyFourHours + 1;

  while (localStart < end) {
    results.push(
      await db.query(
        `SELECT calculated_power FROM "current_values" WHERE time >= ${localStart - 1}ms AND time <= ${localEnd}ms fill(null)`
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
