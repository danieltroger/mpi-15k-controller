import { useCurrentPower } from "./useCurrentPower";
import { useDatabasePower } from "./useDatabasePower";
import { createMemo, getOwner, Resource, runWithOwner } from "solid-js";
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
  const { currentPower, lastBatterySeenFullSinceProgramStart, lastBatterySeenEmptySinceProgramStart } = useCurrentPower(
    mqttValues,
    configSignal
  );
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
  const assumedParasiticConsumption = createMemo(() => config().soc_calculations.current_state.parasitic_consumption);
  const assumedCapacity = createMemo(() => config().soc_calculations.current_state.capacity);

  const {
    energyAddedSinceEmpty,
    energyChargedSinceEmpty,
    energyDischargedSinceEmpty,
    energyDischargedSinceFull,
    energyRemovedSinceFull,
    energyChargedSinceFull,
    socSinceFull,
    socSinceEmpty,
    energyDischargedSinceFullWithoutParasitic,
    energyChargedSinceEmptyWithoutParasitic,
    energyChargedSinceFullWithoutParasitic,
    energyDischargedSinceEmptyWithoutParasitic,
  } = batteryCalculationsDependingOnUnknowns({
    databasePowerValues,
    totalLastFull,
    totalLastEmpty,
    subtractFromPower: assumedParasiticConsumption,
    assumedCapacity,
    currentPower,
  });

  iterativelyFindSocParameters({
    totalLastEmpty,
    totalLastFull,
    configSignal,
    energyDischargedSinceFullWithoutParasitic,
    energyChargedSinceEmptyWithoutParasitic,
    energyChargedSinceFullWithoutParasitic,
    energyDischargedSinceEmptyWithoutParasitic,
  });

  const averageSOC = createMemo(() => {
    const sinceFull = socSinceFull();
    const sinceEmpty = socSinceEmpty();
    const fullInvalid = isNaN(sinceFull!) || Math.abs(sinceFull!) === Infinity;
    const emptyInvalid = isNaN(sinceEmpty!) || Math.abs(sinceEmpty!) === Infinity;
    if (fullInvalid || emptyInvalid) return;
    return (sinceFull! + sinceEmpty!) / 2;
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
    averageSOC,
  };
}
