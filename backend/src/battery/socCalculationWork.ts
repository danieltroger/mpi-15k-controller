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

  const energyAddedSinceEmpty = energyWithoutParasiticSinceEmpty - subtractFromEmptyValues;
  const energyRemovedSinceFull = energyWithoutParasiticSinceFull + subtractFromFullValues;

  const socSinceFull = 100 - (energyRemovedSinceFull / assumedCapacity) * 100;
  const socSinceEmpty = (energyAddedSinceEmpty / assumedCapacity) * 100;

  return { socSinceEmpty, socSinceFull };
}
