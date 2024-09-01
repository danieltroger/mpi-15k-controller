import { Accessor, createEffect, createMemo, createMemo as solidCreateMemo, createSignal } from "solid-js";
import { useDatabasePower } from "./useDatabasePower";
import { useNow } from "../utilities/useNow";

export function calculateBatteryEnergy({
  from,
  databasePowerValues,
  currentPower,
  subtractFromPower,
  invertValues,
}: {
  /**
   * Unix timestamp in milliseconds
   */
  from: Accessor<number | undefined>;
  currentPower: Accessor<{ value: number; time: number } | undefined>;
  databasePowerValues: ReturnType<typeof useDatabasePower>["databasePowerValues"];
  subtractFromPower: Accessor<number>;
  invertValues: boolean;
}) {
  // Calculate from database values how much energy was charged and discharged before the application start
  const databaseEnergy = createMemo(() => {
    const fromValue = from();
    const allDbValues = databasePowerValues();
    if (!fromValue || !allDbValues?.length) return; // Wait for data
    const powerValues = allDbValues.filter(({ time }) => time >= fromValue);
    let databaseEnergy = 0;
    for (let i = 0; i < powerValues.length; i++) {
      const power = powerValues[i];
      const nextPower = powerValues[i + 1];
      if (!nextPower) break;
      const powerValue = power.value;
      const timeDiff = nextPower.time - power.time;
      const energy = (powerValue * timeDiff) / 1000 / 60 / 60;
      databaseEnergy += energy * (invertValues ? -1 : 1);
    }
    return databaseEnergy;
  });

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
