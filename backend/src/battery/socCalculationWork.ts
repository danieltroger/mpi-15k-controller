import { calculateEnergyToSubtract } from "./calculateBatteryEnergy";

export function socCalculationWork({
  energyWithoutParasiticSinceEmpty,
  energyWithoutParasiticSinceFull,
  assumedParasitic,
  assumedCapacity,
  now,
  totalLastFull,
  totalLastEmpty,
}: {
  energyWithoutParasiticSinceEmpty: number;
  energyWithoutParasiticSinceFull: number;
  assumedCapacity: number;
  assumedParasitic: number;
  now: number;
  totalLastFull: number;
  totalLastEmpty: number;
}) {
  const subtractFromFullValues = calculateEnergyToSubtract(totalLastFull, now, assumedParasitic)!;
  const subtractFromEmptyValues = calculateEnergyToSubtract(totalLastEmpty, now, assumedParasitic)!;

  const energySinceEmpty = energyWithoutParasiticSinceEmpty - subtractFromEmptyValues;
  const energySinceFull = energyWithoutParasiticSinceFull - subtractFromFullValues;

  // 1000wh = 1000wh were discharged
  // -100wh = 100wh were charged
  const energyRemovedSinceFull = energySinceFull * -1;

  const socSinceFull = 100 - (energyRemovedSinceFull / assumedCapacity) * 100;
  const socSinceEmpty = (energySinceEmpty / assumedCapacity) * 100;

  return { socSinceEmpty, socSinceFull };
}
