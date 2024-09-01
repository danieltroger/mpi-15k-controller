import { parentPort, workerData } from "worker_threads";
import { SocWorkerData, WorkerResult } from "./socCalculationWorker.types";
import { socCalculationWork } from "./socCalculationWork";
import { log } from "../utilities/logging";

const data: SocWorkerData = workerData;

const start = performance.now();
let iterationsTried = 0;
let bestResult: WorkerResult | null = null;
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
    const result: WorkerResult = { capacity, parasitic, sinceEmpty: socSinceEmpty, sinceFull: socSinceFull };
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
log("Worker calculations took", performance.now() - start, "ms for", iterationsTried, "iterations");
