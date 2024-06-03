import { useCurrentPower } from "./useCurrentPower";
import { useNow } from "../utilities/useNow";
import { useDatabasePower } from "./useDatabasePower";
import { createMemo, createSignal, Resource } from "solid-js";
import { useMQTTValues } from "../useMQTTValues";
import { get_config_object } from "../config";
import { batteryCalculationsDependingOnUnknowns } from "./batteryCalculationsDependingOnUnknowns";
import { AsyncMqttClient } from "async-mqtt";
import { iterativelyFindSocParameters } from "./iterativelyFindSocParameters";
import { reportSOCToMqtt } from "./reportSOCToMqtt";

export function useBatteryValues(
  mqttValues: ReturnType<typeof useMQTTValues>["mqttValues"],
  configSignal: Awaited<ReturnType<typeof get_config_object>>,
  mqttClient: Resource<AsyncMqttClient>
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
  const [assumedParasiticConsumption, setAssumedParasiticConsumption] = createSignal(315);
  const [assumedCapacity, setAssumedCapacity] = createSignal(19.2 * 12 * 3 * 16);

  const {
    energyAddedSinceEmpty,
    energyChargedSinceEmpty,
    energyDischargedSinceEmpty,
    energyDischargedSinceFull,
    energyRemovedSinceFull,
    energyChargedSinceFull,
    socSinceFull,
    socSinceEmpty,
  } = batteryCalculationsDependingOnUnknowns({
    now,
    localPowerHistory,
    databasePowerValues,
    totalLastFull,
    totalLastEmpty,
    subtractFromPower: assumedParasiticConsumption,
    assumedCapacity,
  });

  iterativelyFindSocParameters({
    config,
    totalLastEmpty,
    totalLastFull,
    now,
    localPowerHistory,
    databasePowerValues,
    setAssumedCapacity,
    setAssumedParasiticConsumption,
  });

  const averageSOC = createMemo(() => {
    const sinceFull = socSinceFull();
    const sinceEmpty = socSinceEmpty();
    if (sinceFull === undefined && sinceEmpty === undefined) return;
    if (sinceFull === undefined) return sinceEmpty;
    if (sinceEmpty === undefined) return sinceFull;
    return (sinceFull + sinceEmpty) / 2;
  });

  reportSOCToMqtt({
    mqttClient,
    config,
    averageSOC,
    socSinceEmpty,
    socSinceFull,
  });

  return {
    energyChargedSinceFull,
    energyChargedSinceEmpty,
    energyDischargedSinceEmpty,
    energyDischargedSinceFull,
    currentPower,
    totalLastEmpty,
    totalLastFull,
    energyRemovedSinceFull,
    energyAddedSinceEmpty,
    socSinceEmpty,
    socSinceFull,
    assumedCapacity,
    assumedParasiticConsumption,
  };
}
