import { useCurrentPower } from "./useCurrentPower";
import { useNow } from "./utilities/useNow";
import { useDatabasePower } from "./useDatabasePower";
import { calculateBatteryEnergy } from "./calculateBatteryEnergy";
import { createMemo } from "solid-js";
import { useMQTTValues } from "./useMQTTValues";
import { get_config_object } from "./config";

export function useBatteryValues(
  mqttValues: ReturnType<typeof useMQTTValues>["mqttValues"],
  configSignal: Awaited<ReturnType<typeof get_config_object>>
) {
  const [config] = configSignal;
  const {
    localPowerHistory,
    currentPower,
    lastBatterySeenFullSinceProgramStart,
    lastBatterySeenEmptySinceProgramStart,
  } = useCurrentPower(mqttValues, configSignal);
  const now = useNow();
  const { databasePowerValues, batteryWasLastFullAtAccordingToDatabase, batteryWasLastEmptyAtAccordingToDatabase } =
    useDatabasePower(configSignal);

  const [totalLastFull, totalLastEmpty] = [
    [batteryWasLastFullAtAccordingToDatabase, lastBatterySeenFullSinceProgramStart],
    [batteryWasLastEmptyAtAccordingToDatabase, lastBatterySeenEmptySinceProgramStart],
  ].map(([db, local]) =>
    createMemo(() => {
      const lastSinceStart = local();
      const lastAccordingToDatabase = db();
      if (!lastSinceStart && !lastAccordingToDatabase) return;
      if (!lastSinceStart) return lastAccordingToDatabase;
      if (!lastAccordingToDatabase) return lastSinceStart;
      return Math.max(lastSinceStart, lastAccordingToDatabase);
    })
  );

  const { energyDischarged: energyDischargedSinceEmpty, energyCharged: energyChargedSinceEmpty } =
    calculateBatteryEnergy({
      localPowerHistory,
      databasePowerValues,
      from: totalLastEmpty,
      to: now,
      config,
    });
  const { energyDischarged: energyDischargedSinceFull, energyCharged: energyChargedSinceFull } = calculateBatteryEnergy(
    {
      localPowerHistory,
      databasePowerValues,
      from: totalLastFull,
      to: now,
      config,
    }
  );

  return {
    energyChargedSinceFull,
    energyChargedSinceEmpty,
    energyDischargedSinceEmpty,
    energyDischargedSinceFull,
    currentPower,
    totalLastEmpty,
    totalLastFull,
  };
}
