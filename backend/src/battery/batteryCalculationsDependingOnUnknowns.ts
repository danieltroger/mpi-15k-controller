import { Accessor, createMemo } from "solid-js";
import { InfluxClientAccessor } from "./useDatabasePower";
import { calculateBatteryEnergy } from "./calculateBatteryEnergy";

export function batteryCalculationsDependingOnUnknowns({
  currentPower,
  influxClient,
  totalLastFull,
  totalLastEmpty,
  subtractFromPower,
  assumedCapacity,
}: {
  currentPower: Accessor<{ value: number; time: number } | undefined>;
  influxClient: InfluxClientAccessor;
  totalLastEmpty: Accessor<number | undefined>;
  totalLastFull: Accessor<number | undefined>;
  subtractFromPower: Accessor<number>;
  assumedCapacity: Accessor<number>;
}) {
  // Query integral from lastEmpty to now - energy added since empty
  const { energy: energyAddedSinceEmpty, energyWithoutParasitic: energyWithoutParasiticSinceEmpty } =
    calculateBatteryEnergy({
      currentPower,
      influxClient,
      from: totalLastEmpty,
      subtractFromPower,
      invertValues: false,
    });

  // Query integral from lastFull to now - energy removed since full
  // Due to inversion should show:
  // 1000wh = 1000wh were discharged
  // -100wh = 100wh were charged
  const { energy: energyRemovedSinceFull, energyWithoutParasitic: energyWithoutParasiticSinceFull } =
    calculateBatteryEnergy({
      currentPower,
      influxClient,
      from: totalLastFull,
      subtractFromPower,
      invertValues: true,
    });

  const socSinceFull = createMemo(() => {
    const removedSinceFull = energyRemovedSinceFull();
    if (removedSinceFull === undefined) return undefined;
    const result = 100 - (removedSinceFull / assumedCapacity()) * 100;
    return Math.round(result * 1000) / 1000;
  });
  const socSinceEmpty = createMemo(() => {
    const addedSinceEmpty = energyAddedSinceEmpty();
    if (addedSinceEmpty === undefined) return undefined;
    const result = (addedSinceEmpty / assumedCapacity()) * 100;
    return Math.round(result * 1000) / 1000;
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
