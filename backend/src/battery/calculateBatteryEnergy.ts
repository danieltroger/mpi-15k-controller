import { Accessor, createMemo as solidCreateMemo } from "solid-js";
import { useDatabasePower } from "./useDatabasePower";
import { log } from "../utilities/logging";

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
  databasePowerValues: ReturnType<typeof useDatabasePower>["databasePowerValues"];
  subtractFromPower: Accessor<number>;
  createMemo: typeof solidCreateMemo;
}) {
  const totalPowerHistory = () => {
    const start = performance.now();
    const fromValue = from();
    const filteredLocalPower: { time: number; value: number }[] = [];
    const filteredDatabasePower: { time: number; value: number }[] = [];
    const totalLocalHistory = localPowerHistory();
    const allDatabaseValues = databasePowerValues();

    if (!fromValue || !totalLocalHistory.length || allDatabaseValues == undefined) {
      // Don't return anything until we both have one local value and the database returns a value
      // This is so we don't make wrong assumptions while data is loading
      return { filteredLocalPower, filteredDatabasePower };
    }

    for (let i = 0; i < totalLocalHistory.length; i++) {
      const power = totalLocalHistory[i];
      const { time } = power;
      if (time >= fromValue) {
        if (time <= to()) {
          filteredLocalPower.push(power);
        } else {
          // Since we assume that the array is sorted by time, we can break here to make this calculation faster
          break;
        }
      }
    }
    const firstLocalPower = filteredLocalPower[0]?.time as number | undefined;
    for (let i = 0; i < allDatabaseValues.length; i++) {
      const power = allDatabaseValues[i];
      const { time } = power;
      if (time >= fromValue) {
        // If we don't have local power yet, use only database power
        if (time <= to() && (firstLocalPower == undefined || time <= firstLocalPower)) {
          filteredDatabasePower.push(power);
        } else {
          break;
        }
      }
    }

    log("Merging totalPowerHistory took", performance.now() - start, "ms");

    return { filteredLocalPower, filteredDatabasePower };
  };

  const energy = createMemo<{ energyCharged: number; energyDischarged: number } | undefined>(prev => {
    const start = performance.now();
    // Calculate "totalPowerHistory", but without merging the two parts, since then we have to create multiple arrays and GC:ing those takes time
    const { filteredDatabasePower, filteredLocalPower } = totalPowerHistory();
    const toSubtract = subtractFromPower();
    const totalLength = filteredDatabasePower.length + filteredLocalPower.length;
    const firstLength = filteredDatabasePower.length;
    if (!totalLength) {
      if (prev) {
        // When the battery just became full (or empty) (we have returned something before), we won't have any power values for a short time, just return 0 (which is true) in that time
        return { energyCharged: 0, energyDischarged: 0 };
      }
      // During program initialization, before we've gotten a value from the DB, return undefined
      return;
    }
    let energyCharged = 0;
    let energyDischarged = 0;
    for (let i = 0; i < totalLength; i++) {
      const isInFirstArray = i < firstLength;
      const power = isInFirstArray ? filteredDatabasePower[i] : filteredLocalPower[i - firstLength];
      const indexOfNextPower = i + 1;
      const nextPowerIsInFirstArray = indexOfNextPower < firstLength;
      const nextPower = nextPowerIsInFirstArray
        ? filteredDatabasePower[indexOfNextPower]
        : filteredLocalPower[indexOfNextPower - firstLength];
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
    log("Calculating energy took", performance.now() - start, "ms");
    return { energyCharged, energyDischarged };
  });

  return {
    energyCharged: createMemo(() => energy()?.energyCharged),
    energyDischarged: createMemo(() => energy()?.energyDischarged),
  };
}
