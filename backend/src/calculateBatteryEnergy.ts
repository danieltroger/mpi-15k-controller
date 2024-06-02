import { Accessor, createMemo } from "solid-js";
import { get_config_object } from "./config";

export function calculateBatteryEnergy({
  from,
  to,
  databasePowerValues,
  localPowerHistory,
  subtractFromPower,
  createMemo,
}: {
  /**
   * Unix timestamp in milliseconds
   */
  from: Accessor<number | undefined>;
  to: Accessor<number>;
  /**
   * Reactive store with the local power history
   */
  localPowerHistory: Accessor<{ value: number; time: number }[]>;
  databasePowerValues: Accessor<{ time: number; value: number }[]>;
  subtractFromPower: Accessor<number>;
  createMemo: <T>(fn: () => T) => Accessor<T>;
}) {
  const totalPowerHistory = createMemo(() => {
    const fromValue = from();
    if (!fromValue) return [];
    const localPower = localPowerHistory().filter(({ time }) => time >= fromValue && time <= to());
    const databasePower = databasePowerValues().filter(({ time }) => time >= fromValue && time <= to());
    const firstLocalPower = localPower[0]?.time;
    const filteredDatabasePower = databasePower.filter(({ time }) => time <= firstLocalPower);
    return [...filteredDatabasePower, ...localPower];
  });

  const energy = createMemo<{ energyCharged: number; energyDischarged: number } | undefined>(prev => {
    const powerValues = totalPowerHistory();
    const toSubtract = subtractFromPower();
    if (!powerValues?.length) {
      if (prev) {
        // When the battery just became full (or empty) (we have returned something before), we won't have any power values for a short time, just return 0 (which is true) in that time
        return { energyCharged: 0, energyDischarged: 0 };
      }
      // During program initialisation, before we've gotten a value from the DB, return undefined
      return;
    }
    let energyCharged = 0;
    let energyDischarged = 0;
    for (let i = 0; i < powerValues.length; i++) {
      const power = powerValues[i];
      const nextPower = powerValues[i + 1];
      if (!nextPower) break;
      const correctedPowerValue = power.value - toSubtract;
      const timeDiff = nextPower.time - power.time;
      const energy = (correctedPowerValue * timeDiff) / 1000 / 60 / 60;
      if (correctedPowerValue > 0) {
        energyCharged += energy;
      } else if (correctedPowerValue < 0) {
        energyDischarged += energy;
      }
    }
    return { energyCharged, energyDischarged };
  });

  return {
    energyCharged: createMemo(() => energy()?.energyCharged),
    energyDischarged: createMemo(() => energy()?.energyDischarged),
  };
}
