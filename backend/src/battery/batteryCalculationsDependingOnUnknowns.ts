import { Accessor, createMemo as solidCreateMemo } from "solid-js";
import { useDatabasePower } from "./useDatabasePower";
import { calculateBatteryEnergy } from "./calculateBatteryEnergy";

export function batteryCalculationsDependingOnUnknowns({
  currentPower,
  databasePowerValues,
  totalLastFull,
  totalLastEmpty,
  subtractFromPower,
  assumedCapacity,
  createMemo = solidCreateMemo,
}: {
  currentPower: Accessor<{ value: number; time: number } | undefined>;
  databasePowerValues: ReturnType<typeof useDatabasePower>["databasePowerValues"];
  totalLastEmpty: Accessor<number | undefined>;
  totalLastFull: Accessor<number | undefined>;
  subtractFromPower: Accessor<number>;
  assumedCapacity: Accessor<number>;
  createMemo?: typeof solidCreateMemo;
}) {
  const {
    energyDischarged: energyDischargedSinceEmpty,
    energyCharged: energyChargedSinceEmpty,
    energyDischargedWithoutParasitic: energyDischargedSinceEmptyWithoutParasitic,
    energyChargedWithoutParasitic: energyChargedSinceEmptyWithoutParasitic,
  } = calculateBatteryEnergy({
    currentPower,
    databasePowerValues,
    from: totalLastEmpty,
    subtractFromPower,
    createMemo,
  });
  const {
    energyDischarged: energyDischargedSinceFull,
    energyCharged: energyChargedSinceFull,
    energyDischargedWithoutParasitic: energyDischargedSinceFullWithoutParasitic,
    energyChargedWithoutParasitic: energyChargedSinceFullWithoutParasitic,
  } = calculateBatteryEnergy({
    currentPower,
    databasePowerValues,
    from: totalLastFull,
    subtractFromPower,
    createMemo,
  });

  // 1000wh = 1000wh were discharged
  // -100wh = 100wh were charged
  const energyRemovedSinceFull = createMemo(() => {
    const discharged = energyDischargedSinceFull();
    const charged = energyChargedSinceFull();
    if (charged == undefined || discharged == undefined) return undefined;
    return Math.abs(discharged) - Math.abs(charged);
  });

  const energyAddedSinceEmpty = createMemo(() => {
    const discharged = energyDischargedSinceEmpty();
    const charged = energyChargedSinceEmpty();
    if (charged == undefined || discharged == undefined) return undefined;
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
    energyDischargedSinceEmptyWithoutParasitic,
    energyChargedSinceEmptyWithoutParasitic,
    energyDischargedSinceFullWithoutParasitic,
    energyChargedSinceFullWithoutParasitic,
  };
}
