export type SocWorkerData = {
  startCapacity: number;
  endCapacity: number;
  startParasitic: number;
  endParasitic: number;
  energyWithoutParasiticSinceEmpty: number;
  energyWithoutParasiticSinceFull: number;
  now: number;
  totalLastFull: number;
  totalLastEmpty: number;
};

export type WorkerResult = {
  capacity: number;
  parasitic: number;
  sinceEmpty: number;
  sinceFull: number;
};
