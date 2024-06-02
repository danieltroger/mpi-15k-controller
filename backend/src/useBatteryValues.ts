import { useCurrentPower } from "./useCurrentPower";
import { useNow } from "./utilities/useNow";
import { useDatabasePower } from "./useDatabasePower";
import { calculateBatteryEnergy } from "./calculateBatteryEnergy";
import { Accessor, createEffect, createMemo, createRoot, createSignal, untrack } from "solid-js";
import { useMQTTValues } from "./useMQTTValues";
import { Config, get_config_object } from "./config";
import { log } from "./utilities/logging";

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
    calculateSoc: ({ assumeParasiticConsumption, assumeCapacity }) =>
      batteryCalculationsDependingOnUnknowns({
        now,
        localPowerHistory,
        databasePowerValues,
        totalLastFull,
        totalLastEmpty,
        subtractFromPower: () => assumeParasiticConsumption,
        assumedCapacity: () => assumeCapacity,
      }),
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

function iterativelyFindSocParameters({
  config,
  calculateSoc,
}: {
  calculateSoc: (params: { assumeParasiticConsumption: number; assumeCapacity: number }) => {
    socSinceFull: Accessor<number | undefined>;
    socSinceEmpty: Accessor<number | undefined>;
  };
  config: Accessor<Config>;
}) {
  const startCapacityWh = createMemo(
    () => config().soc_calculations.capacity_per_cell_from_wh * config().soc_calculations.number_of_cells
  );
  const endCapacityWh = createMemo(
    () => config().soc_calculations.capacity_per_cell_to_wh * config().soc_calculations.number_of_cells
  );
  const startParasiticConsumption = createMemo(() => config().soc_calculations.parasitic_consumption_from);
  const endParasiticConsumption = createMemo(() => config().soc_calculations.parasitic_consumption_to);
  createEffect(() => {
    const startCapacity = startCapacityWh();
    const endCapacity = endCapacityWh();
    const startParasitic = startParasiticConsumption();
    const endParasitic = endParasiticConsumption();
    untrack(() => {
      for (let capacity = startCapacity; capacity <= endCapacity; capacity += 1) {
        for (let parasitic = startParasitic; parasitic <= endParasitic; parasitic += 1) {
          const { socSinceFull, socSinceEmpty } = createRoot(dispose => {
            const result = calculateSoc({
              assumeCapacity: capacity,
              assumeParasiticConsumption: parasitic,
            });
            // We don't want calculateSoc to do any reactive stuff in this case so we just give it its own root and instantly dispose it after the first run, unsure how much overhead this adds
            dispose();
            return result;
          });
          const sinceFull = socSinceFull();
          const sinceEmpty = socSinceEmpty();
          if (sinceEmpty == undefined || sinceFull == undefined) return;
          if (Math.abs(sinceFull - sinceEmpty) < 0.1) {
            log(
              "Found parameters:",
              { capacity, parasitic, sinceEmpty, sinceFull },
              "where SOC is the same at full and empty"
            );
          }
        }
      }
    });
  });
}

function batteryCalculationsDependingOnUnknowns({
  now,
  localPowerHistory,
  databasePowerValues,
  totalLastFull,
  totalLastEmpty,
  subtractFromPower,
  assumedCapacity,
}: {
  now: Accessor<number>;
  localPowerHistory: ReturnType<typeof useCurrentPower>["localPowerHistory"];
  databasePowerValues: ReturnType<typeof useDatabasePower>["databasePowerValues"];
  totalLastEmpty: Accessor<number | undefined>;
  totalLastFull: Accessor<number | undefined>;
  subtractFromPower: Accessor<number>;
  assumedCapacity: Accessor<number>;
}) {
  const { energyDischarged: energyDischargedSinceEmpty, energyCharged: energyChargedSinceEmpty } =
    calculateBatteryEnergy({
      localPowerHistory,
      databasePowerValues,
      from: totalLastEmpty,
      to: now,
      subtractFromPower,
    });
  const { energyDischarged: energyDischargedSinceFull, energyCharged: energyChargedSinceFull } = calculateBatteryEnergy(
    {
      localPowerHistory,
      databasePowerValues,
      from: totalLastFull,
      to: now,
      subtractFromPower,
    }
  );

  // 1000wh = 1000wh were discharged
  // -100wh = 100wh were charged
  const energyRemovedSinceFull = createMemo(() => {
    const discharged = energyDischargedSinceFull();
    const charged = energyChargedSinceFull();
    if (charged == undefined && discharged == undefined) return undefined;
    if (charged == undefined) return Math.abs(discharged!);
    if (discharged == undefined) return Math.abs(charged) * -1;
    return Math.abs(discharged) - Math.abs(charged);
  });

  const energyAddedSinceEmpty = createMemo(() => {
    const discharged = energyDischargedSinceEmpty();
    const charged = energyChargedSinceEmpty();
    if (charged == undefined && discharged == undefined) return undefined;
    if (charged == undefined) return Math.abs(discharged!) * -1;
    if (discharged == undefined) return Math.abs(charged);
    return Math.abs(charged) - Math.abs(discharged);
  });

  const socSinceFull = createMemo(() => {
    const removedSinceFull = energyRemovedSinceFull();
    if (removedSinceFull === undefined) return undefined;
    return 100 - (removedSinceFull / assumedCapacity()) * 100;
  });
  const socSinceEmpty = createMemo(() => {
    const addedSinceEmpty = energyAddedSinceEmpty();
    if (addedSinceEmpty === undefined) return undefined;
    return (addedSinceEmpty / assumedCapacity()) * 100;
  });

  return {
    energyChargedSinceFull,
    energyChargedSinceEmpty,
    energyDischargedSinceEmpty,
    energyDischargedSinceFull,
    energyRemovedSinceFull,
    energyAddedSinceEmpty,
    socSinceEmpty,
    socSinceFull,
  };
}
