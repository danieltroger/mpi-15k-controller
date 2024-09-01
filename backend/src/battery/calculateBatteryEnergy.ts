import { Accessor, createEffect, createMemo as solidCreateMemo, createSignal } from "solid-js";
import { useDatabasePower } from "./useDatabasePower";
import { useNow } from "../utilities/useNow";

export function calculateBatteryEnergy({
  from,
  databasePowerValues,
  currentPower,
  subtractFromPower,
  createMemo,
}: {
  /**
   * Unix timestamp in milliseconds
   */
  from: Accessor<number | undefined>;
  currentPower: Accessor<{ value: number; time: number } | undefined>;
  databasePowerValues: ReturnType<typeof useDatabasePower>["databasePowerValues"];
  subtractFromPower: Accessor<number>;
  createMemo: typeof solidCreateMemo;
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

  const [totalEnergyCharged, setTotalEnergyCharged] = createSignal<number | undefined>(undefined);
  const [totalEnergyDischarged, setTotalEnergyDischarged] = createSignal<number | undefined>(undefined);
  const [sumEnergyToggle, setSumEnergyToggle] = createSignal(false);
  const getNow = useNow();

  let localEnergyCharged = 0;
  let localEnergyDischarged = 0;
  let lastPowerValue: { value: number; time: number } | undefined;

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

  // Every time from changes, assume we've reached a full/empty event and reset the local energy
  // This is because we don't know anymore from when our energy values are
  // But the "from" shouldn't change in any other situation (except application init but we ignore when it's undefined)
  createEffect(() => {
    const start = from();
    if (!start) return;
    localEnergyCharged = 0;
    localEnergyDischarged = 0;
  });

  // When anything changes, sum up the energy from database and local
  createEffect(() => {
    sumEnergyToggle();
    const databaseValues = databaseEnergy();
    if (!databaseValues) return;
    const { databaseEnergyCharged, databaseEnergyDischarged } = databaseValues;
    const totalCharged = databaseEnergyCharged + localEnergyCharged;
    const totalDischarged = databaseEnergyDischarged + localEnergyDischarged;

    setTotalEnergyCharged(totalCharged);
    setTotalEnergyDischarged(totalDischarged);
  });

  const energyToSubtract = createMemo(() => {
    const now = getNow();
    const start = from();
    if (!start) return;
    const powerToSubtract = subtractFromPower();
    // Calculate the amount of energy to subtract from "from" to "now" due to parasitic consumption and subtract it
    const timeDiff = now - start;

    return (powerToSubtract * timeDiff) / 1000 / 60 / 60;
  });

  return {
    energyChargedWithoutParasitic: totalEnergyCharged,
    energyDischargedWithoutParasitic: totalEnergyDischarged,
    energyCharged: createMemo(() => {
      const totalCharged = totalEnergyCharged();
      const toSubtract = energyToSubtract();
      if (totalCharged == undefined || toSubtract == undefined) return;
      return totalCharged - toSubtract;
    }),
    energyDischarged: createMemo(() => {
      const totalDischarged = totalEnergyDischarged();
      const toSubtract = energyToSubtract();
      if (totalDischarged == undefined || toSubtract == undefined) return;
      return totalDischarged - toSubtract;
    }),
  };
}
