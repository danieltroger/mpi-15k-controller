import { Accessor, createEffect, createMemo, createResource, createSignal } from "solid-js";
import { InfluxClientAccessor, queryEnergyIntegral } from "./useDatabasePower";
import { useNow } from "../utilities/useNow";
import { logLog } from "../utilities/logging";

export function calculateBatteryEnergy({
  from,
  influxClient,
  currentPower,
  subtractFromPower,
  invertValues,
}: {
  /**
   * Unix timestamp in milliseconds
   */
  from: Accessor<number | undefined>;
  influxClient: InfluxClientAccessor;
  currentPower: Accessor<{ value: number; time: number } | undefined>;
  subtractFromPower: Accessor<number>;
  invertValues: boolean;
}) {
  // Calculate from database values how much energy was charged and discharged before the application start
  // Uses InfluxDB's integral() function to compute this in a single query instead of fetching millions of rows
  const [databaseEnergy] = createResource(
    () => ({ fromValue: from(), db: influxClient() }),
    async ({ fromValue, db }) => {
      if (!fromValue || !db) return; // Wait for data
      logLog(
        `Querying database energy integral since ${invertValues ? "last full" : "last empty"}:`,
        new Date(fromValue).toISOString()
      );
      const energy = await queryEnergyIntegral(db, fromValue);
      if (energy === undefined) return undefined;
      // Apply inversion: when invertValues is true, we're measuring energy removed (discharged)
      // so positive power (charging) should subtract, and negative power (discharging) should add
      return energy * (invertValues ? -1 : 1);
    }
  );

  const [sumEnergyToggle, setSumEnergyToggle] = createSignal(false);

  let localEnergy = 0;
  let lastPowerValue: { value: number; time: number } | undefined;

  // Every time from changes, assume we've reached a full/empty event and reset the local energy
  // This is because we don't know anymore from when our energy values are
  // But the "from" shouldn't change in any other situation (except application init but we ignore when it's undefined)
  createEffect(() => {
    const start = from();
    if (!start) return;
    localEnergy = 0;
  });

  // Only keep a variable that we modify for the energy being charged/discharged while the program runs, for efficiency. This updates it
  createEffect(() => {
    const currentPowerValue = currentPower();
    if (!currentPowerValue) return;
    if (lastPowerValue) {
      const powerValue = lastPowerValue.value;
      const timeDiff = currentPowerValue.time - lastPowerValue.time;
      const energy = (powerValue * timeDiff) / 1000 / 60 / 60;
      localEnergy += energy * (invertValues ? -1 : 1);
    }
    lastPowerValue = currentPowerValue;
    setSumEnergyToggle(prev => !prev);
  });

  // When anything changes, sum up the energy from database and local
  const totalEnergy = createMemo(() => {
    sumEnergyToggle();
    const databaseValue = databaseEnergy();
    if (databaseValue == undefined) return;
    return databaseValue + localEnergy;
  });
  const energyToSubtract = createMemo(() => calculateEnergyToSubtract(from(), useNow(), subtractFromPower()));

  return {
    energyWithoutParasitic: totalEnergy,
    energy: createMemo(() => {
      let totalChargedOrDischarged = totalEnergy();
      const toSubtract = energyToSubtract();
      if (totalChargedOrDischarged == undefined || toSubtract == undefined) return;
      if (invertValues) {
        totalChargedOrDischarged += toSubtract;
      } else {
        totalChargedOrDischarged -= toSubtract;
      }
      return totalChargedOrDischarged;
    }),
  };
}

/**
 * Calculate the amount of energy to subtract from "from" to "now" due to parasitic consumption
 */
export function calculateEnergyToSubtract(from: number | undefined, now: number, powerToSubtract: number) {
  if (!from) return;
  const timeDiff = now - from;
  return (powerToSubtract * timeDiff) / 1000 / 60 / 60;
}
