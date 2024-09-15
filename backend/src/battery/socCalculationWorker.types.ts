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
  jobId: string;
};

export type WorkerResult = {
  capacity: number;
  parasitic: number;
  sinceEmpty: number;
  sinceFull: number;
  jobId: string;
  started?: never;
  done?: never;
};

export type WorkerResponse =
  | { started: true; jobId?: never; done?: never }
  | WorkerResult
  | { done: true; jobId: string; started?: never };
