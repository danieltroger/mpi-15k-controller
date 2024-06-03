import { Accessor, createMemo as solidCreateMemo } from "solid-js";
import { useCurrentPower } from "./useCurrentPower";
import { useDatabasePower } from "./useDatabasePower";
import { calculateBatteryEnergy } from "./calculateBatteryEnergy";

// Used by worker and main thread
export function batteryCalculationsDependingOnUnknowns({
  now,
  localPowerHistory,
  databasePowerValues,
  totalLastFull,
  totalLastEmpty,
  subtractFromPower,
  assumedCapacity,
  createMemo = solidCreateMemo,
}: {
  now: Accessor<number>;
  localPowerHistory: ReturnType<typeof useCurrentPower>["localPowerHistory"];
  databasePowerValues: ReturnType<typeof useDatabasePower>["databasePowerValues"];
  totalLastEmpty: Accessor<number | undefined>;
  totalLastFull: Accessor<number | undefined>;
  subtractFromPower: Accessor<number>;
  assumedCapacity: Accessor<number>;
  createMemo?: typeof solidCreateMemo;
}) {
  const { energyDischarged: energyDischargedSinceEmpty, energyCharged: energyChargedSinceEmpty } =
    calculateBatteryEnergy({
      localPowerHistory,
      databasePowerValues,
      from: totalLastEmpty,
      to: now,
      subtractFromPower,
      createMemo,
    });
  const { energyDischarged: energyDischargedSinceFull, energyCharged: energyChargedSinceFull } = calculateBatteryEnergy(
    {
      localPowerHistory,
      databasePowerValues,
      from: totalLastFull,
      to: now,
      subtractFromPower,
      createMemo,
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
