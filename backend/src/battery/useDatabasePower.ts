import Influx, { IResults } from "influx";
import { get_config_object } from "../config";
import { createMemo, createResource } from "solid-js";
import { error, log } from "../utilities/logging";
import { useNow } from "../utilities/useNow";

export function useDatabasePower([config]: Awaited<ReturnType<typeof get_config_object>>) {
  const currentTime = useNow();
  const host = createMemo(() => config()?.influxdb?.host);
  const database = createMemo(() => config()?.influxdb?.database);
  const username = createMemo(() => config()?.influxdb?.username);
  const password = createMemo(() => config()?.influxdb?.password);
  const influxClient = createMemo(() => {
    if (!host() || !database() || !username() || !password()) {
      error(
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
    const currentTimeValue = currentTime();
    const date = new Date(currentTimeValue);
    date.setHours(0, 0, 0, 0);
    return +date;
  });
  const fullWhenAccessor = createMemo(() => config().full_battery_voltage * 10);

  const [batteryWasLastFullAt] = createResource(
    () => [influxClient(), fullWhenAccessor()] as const,
    async ([db, fullWhen]) => {
      if (!db) return;
      log("Getting last full time from database");
      const [response] = await db.query(
        `SELECT last("battery_voltage") FROM "mpp-solar" WHERE "battery_voltage" >= ${fullWhen}`
      );
      let timeOfLastFull = (response as any)?.time?.getNanoTime?.();
      if (!isNaN(timeOfLastFull)) {
        const when = Math.round(timeOfLastFull / 1000 / 1000);
        log("Got from database that battery was last full at ", new Date(when).toISOString());
        return when;
      }
    }
  );
  const emptyAtAccessor = createMemo(() => config().soc_calculations.battery_empty_at * 10);
  const [batteryWasLastEmptyAt] = createResource(
    () => [influxClient(), emptyAtAccessor()] as const,
    async ([db, emptyAt]) => {
      if (!db) return;
      const [response] = await db.query(
        `SELECT last("battery_voltage") FROM "mpp-solar" WHERE "battery_voltage" <= ${emptyAt}`
      );
      let timeOfLastEmpty = (response as any)?.time?.getNanoTime?.();
      if (!isNaN(timeOfLastEmpty)) {
        const when = Math.round(timeOfLastEmpty / 1000 / 1000);
        log("Got from database that battery was last empty at ", new Date(when).toISOString());
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
    if (!values) return;
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

  return {
    batteryWasLastFullAtAccordingToDatabase: batteryWasLastFullAt,
    databasePowerValues: powerValues,
    batteryWasLastEmptyAtAccordingToDatabase: batteryWasLastEmptyAt,
  };
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
