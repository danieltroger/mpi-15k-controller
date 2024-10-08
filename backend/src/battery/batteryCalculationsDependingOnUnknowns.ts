import { Accessor, createMemo, createMemo as solidCreateMemo } from "solid-js";
import { useDatabasePower } from "./useDatabasePower";
import { calculateBatteryEnergy } from "./calculateBatteryEnergy";

export function batteryCalculationsDependingOnUnknowns({
  currentPower,
  databasePowerValues,
  totalLastFull,
  totalLastEmpty,
  subtractFromPower,
  assumedCapacity,
}: {
  currentPower: Accessor<{ value: number; time: number } | undefined>;
  databasePowerValues: ReturnType<typeof useDatabasePower>["databasePowerValues"];
  totalLastEmpty: Accessor<number | undefined>;
  totalLastFull: Accessor<number | undefined>;
  subtractFromPower: Accessor<number>;
  assumedCapacity: Accessor<number>;
}) {
  const { energy: energyAddedSinceEmpty, energyWithoutParasitic: energyWithoutParasiticSinceEmpty } =
    calculateBatteryEnergy({
      currentPower,
      databasePowerValues,
      from: totalLastEmpty,
      subtractFromPower,
      invertValues: false,
    });

  // Due to inversion should show
  // 1000wh = 1000wh were discharged
  // -100wh = 100wh were charged
  const { energy: energyRemovedSinceFull, energyWithoutParasitic: energyWithoutParasiticSinceFull } =
    calculateBatteryEnergy({
      currentPower,
      databasePowerValues,
      from: totalLastFull,
      subtractFromPower,
      invertValues: true,
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
    energyRemovedSinceFull,
    energyAddedSinceEmpty,
    socSinceEmpty,
    socSinceFull,
    energyWithoutParasiticSinceEmpty,
    energyWithoutParasiticSinceFull,
  };
}
