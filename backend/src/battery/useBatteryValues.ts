import { useCurrentPower } from "./useCurrentPower";
import { useDatabasePower } from "./useDatabasePower";
import { catchError, createEffect, createMemo, createSignal, Resource } from "solid-js";
import { useMQTTValues } from "../useMQTTValues";
import { get_config_object } from "../config";
import { batteryCalculationsDependingOnUnknowns } from "./batteryCalculationsDependingOnUnknowns";
import { AsyncMqttClient } from "async-mqtt";
import { iterativelyFindSocParameters } from "./iterativelyFindSocParameters";
import { reportSOCToMqtt } from "./reportSOCToMqtt";
import { error } from "../utilities/logging";

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
    energyRemovedSinceFull,
    socSinceFull,
    socSinceEmpty,
    energyWithoutParasiticSinceEmpty,
    energyWithoutParasiticSinceFull,
  } = batteryCalculationsDependingOnUnknowns({
    databasePowerValues,
    totalLastFull,
    totalLastEmpty,
    subtractFromPower: assumedParasiticConsumption,
    assumedCapacity,
    currentPower,
  });

  const [iterativeFindingFailed, setIterativeFindingFailed] = createSignal(false);

  createEffect(() => {
    if (iterativeFindingFailed()) return;
    catchError(
      () =>
        iterativelyFindSocParameters({
          totalLastEmpty,
          totalLastFull,
          configSignal,
          energyWithoutParasiticSinceEmpty,
          energyWithoutParasiticSinceFull,
        }),
      e => {
        setIterativeFindingFailed(true);
        error("Iteratively finding SOC parameters failed", e, "restarting in 60s");
        setTimeout(() => setIterativeFindingFailed(false), 60_000);
      }
    );
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
