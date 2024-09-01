export type SocWorkerData = {
  startCapacity: number;
  endCapacity: number;
  startParasitic: number;
  endParasitic: number;
  energyDischargedSinceFullWithoutParasitic: number;
  energyChargedSinceEmptyWithoutParasitic: number;
  energyChargedSinceFullWithoutParasitic: number;
  energyDischargedSinceEmptyWithoutParasitic: number;
  now: number;
};

export type WorkerResult = {
  capacity: number;
  parasitic: number;
  sinceEmpty: number;
  sinceFull: number;
};
