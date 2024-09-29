import { parentPort } from "worker_threads";
import { SocWorkerData, WorkerResponse } from "./socCalculationWorker.types";
import { socCalculationWork } from "./socCalculationWork";
import { log } from "../utilities/logging";

// Listen for messages from the main thread
parentPort!.on("message", (data: SocWorkerData) => {
  const start = performance.now();
  let iterationsTried = 0;
  let bestResult: WorkerResponse | null = null;
  let foundOkResult = false;

  for (let capacity = data.startCapacity; capacity <= data.endCapacity; capacity++) {
    for (let parasitic = data.endParasitic; parasitic >= data.startParasitic; parasitic--) {
      iterationsTried++;
      const { socSinceFull, socSinceEmpty } = socCalculationWork({
        ...data,
        assumedCapacity: capacity,
        assumedParasitic: parasitic,
      });

      const diff = Math.abs(socSinceFull - socSinceEmpty);
      const result: WorkerResponse = {
        capacity,
        parasitic,
        sinceEmpty: socSinceEmpty,
        sinceFull: socSinceFull,
        jobId: data.jobId,
      };
      if (diff < 0.01) {
        foundOkResult = true;
        parentPort!.postMessage(result);
      }

      if (!bestResult || diff < Math.abs(bestResult.sinceFull - bestResult.sinceEmpty)) {
        bestResult = result;
      }
    }
  }

  if (!foundOkResult) {
    // If no result is close enough, send the best found
    parentPort!.postMessage(bestResult);
  }

  parentPort!.postMessage({ done: true, jobId: data.jobId });
});

// Signal that the worker is initially ready
parentPort!.postMessage({ started: true } as WorkerResponse);
