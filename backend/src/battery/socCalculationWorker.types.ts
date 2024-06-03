export type SocWorkerData = {
  now: number;
  localPowerHistory: { value: number; time: number }[];
  databasePowerValues: { time: number; value: number }[];
  totalLastFull: number | undefined;
  totalLastEmpty: number | undefined;
  startCapacity: number;
  endCapacity: number;
  startParasitic: number;
  endParasitic: number;
};

export type WorkerResult = {
  capacity: number;
  parasitic: number;
  sinceEmpty: number;
  sinceFull: number;
};
