import { Accessor, createEffect, createMemo, createMemo as solidCreateMemo, createSignal } from "solid-js";
import { useDatabasePower } from "./useDatabasePower";
import { useNow } from "../utilities/useNow";

export function calculateBatteryEnergy({
  from,
  databasePowerValues,
  currentPower,
  subtractFromPower,
  isSinceFull,
}: {
  /**
   * Unix timestamp in milliseconds
   */
  from: Accessor<number | undefined>;
  currentPower: Accessor<{ value: number; time: number } | undefined>;
  databasePowerValues: ReturnType<typeof useDatabasePower>["databasePowerValues"];
  subtractFromPower: Accessor<number>;
  isSinceFull: boolean;
}) {
  // Calculate from database values how much energy was charged and discharged before the application start
  const databaseEnergy = createMemo(() => {
    const fromValue = from();
    const allDbValues = databasePowerValues();
    if (!fromValue || !allDbValues?.length) return; // Wait for data
    const powerValues = allDbValues.filter(({ time }) => time >= fromValue);
    let databaseEnergyCharged = 0;
    let databaseEnergyDischarged = 0;
    for (let i = 0; i < powerValues.length; i++) {
      const power = powerValues[i];
      const nextPower = powerValues[i + 1];
      if (!nextPower) break;
      const powerValue = power.value;
      const timeDiff = nextPower.time - power.time;
      const energy = (powerValue * timeDiff) / 1000 / 60 / 60;
      if (powerValue > 0) {
        databaseEnergyCharged += energy;
      } else if (powerValue < 0) {
        databaseEnergyDischarged += energy;
      }
    }
    return { databaseEnergyCharged, databaseEnergyDischarged };
  });

  const [sumEnergyToggle, setSumEnergyToggle] = createSignal(false);

  let localEnergyCharged = 0;
  let localEnergyDischarged = 0;
  let lastPowerValue: { value: number; time: number } | undefined;

  // Every time from changes, assume we've reached a full/empty event and reset the local energy
  // This is because we don't know anymore from when our energy values are
  // But the "from" shouldn't change in any other situation (except application init but we ignore when it's undefined)
  createEffect(() => {
    const start = from();
    if (!start) return;
    localEnergyCharged = 0;
    localEnergyDischarged = 0;
  });

  // Only keep a variable that we modify for the energy being charged/discharged while the program runs, for efficiency. This updates it
  createEffect(() => {
    const currentPowerValue = currentPower();
    if (!currentPowerValue) return;
    if (lastPowerValue) {
      const powerValue = lastPowerValue.value;
      const timeDiff = currentPowerValue.time - lastPowerValue.time;
      const energy = (powerValue * timeDiff) / 1000 / 60 / 60;
      if (powerValue > 0) {
        localEnergyCharged += energy;
      } else if (powerValue < 0) {
        localEnergyDischarged += energy;
      }
    }
    lastPowerValue = currentPowerValue;
    setSumEnergyToggle(prev => !prev);
  });

  // When anything changes, sum up the energy from database and local
  const totalEnergy = createMemo(() => {
    sumEnergyToggle();
    const databaseValue = databaseEnergy();
    if (databaseValue == undefined) return;
    const { databaseEnergyDischarged, databaseEnergyCharged } = databaseValue;
    const totalCharged = databaseEnergyCharged + localEnergyCharged;
    const totalDischarged = databaseEnergyDischarged + localEnergyDischarged;
    // Legacy to divide in total charged and discharged and do this, but I can't get it working without
    // Doing it here now so we can easily to the subtracting on the total, if we have to do it on the parts it gets complex
    if (isSinceFull) {
      return Math.abs(totalDischarged) - Math.abs(totalCharged);
    } else {
      return Math.abs(totalCharged) - Math.abs(totalDischarged);
    }
  });
  const energyToSubtract = createMemo(() => calculateEnergyToSubtract(from(), useNow(), subtractFromPower()));

  return {
    energyWithoutParasitic: totalEnergy,
    energy: createMemo(() => {
      const totalCharged = totalEnergy();
      const toSubtract = energyToSubtract();
      if (totalCharged == undefined || toSubtract == undefined) return;
      return totalCharged - (toSubtract * isSinceFull ? -1 : 1);
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
