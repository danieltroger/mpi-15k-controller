import { Accessor, createMemo } from "solid-js";

export function calculateBatteryEnergy({
  from,
  to,
  databasePowerValues,
  localPowerHistory,
}: {
  /**
   * Unix timestamp in milliseconds
   */
  from: Accessor<number | undefined>;
  to: Accessor<number>;
  /**
   * Reactive store with the local power history
   */
  localPowerHistory: { value: number; time: number }[];
  databasePowerValues: Accessor<{ time: number; value: number }[]>;
}) {
  const totalPowerHistory = createMemo(() => {
    const fromValue = from();
    if (!fromValue) return [];
    const localPower = localPowerHistory.filter(({ time }) => time >= fromValue && time <= to());
    const databasePower = databasePowerValues().filter(({ time }) => time >= fromValue && time <= to());
    const firstLocalPower = localPower[0]?.time;
    const filteredDatabasePower = databasePower.filter(({ time }) => time <= firstLocalPower);
    return [...filteredDatabasePower, ...localPower];
  });

  const energy = createMemo(() => {
    const powerValues = totalPowerHistory();
    if (!powerValues) return;
    let energyCharged = 0;
    let energyDischarged = 0;
    for (let i = 0; i < powerValues.length; i++) {
      const power = powerValues[i];
      const nextPower = powerValues[i + 1];
      if (!nextPower) break;
      const timeDiff = nextPower.time - power.time;
      const energy = (power.value * timeDiff) / 1000 / 60 / 60;
      if (power.value > 0) {
        energyCharged += energy;
      } else if (power.value < 0) {
        energyDischarged += energy;
      }
    }
    return { energyCharged, energyDischarged };
  });

  return {
    energyChargedSinceFull: createMemo(() => energy()?.energyCharged),
    energyDischargedSinceFull: createMemo(() => energy()?.energyDischarged),
  };
}
