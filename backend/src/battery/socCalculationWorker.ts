import { parentPort, workerData } from "worker_threads";
import { SocWorkerData, WorkerResult } from "./socCalculationWorker.types";
import { socCalculationWork } from "./socCalculationWork";

const data: SocWorkerData = workerData;

function optimizeCalculation(data: SocWorkerData) {
  let stepCapacity = Math.max(1, Math.floor((data.endCapacity - data.startCapacity) / 10));
  let stepParasitic = Math.max(1, Math.floor((data.endParasitic - data.startParasitic) / 10));
  let bestResult: WorkerResult | null = null;
  const results: WorkerResult[] = [];

  while (stepCapacity >= 1 && stepParasitic >= 1) {
    for (let capacity = data.startCapacity; capacity <= data.endCapacity; capacity += stepCapacity) {
      for (let parasitic = data.endParasitic; parasitic >= data.startParasitic; parasitic -= stepParasitic) {
        const { socSinceFull, socSinceEmpty } = socCalculationWork({
          energyDischargedSinceFullWithoutParasitic: data.energyDischargedSinceFullWithoutParasitic,
          energyChargedSinceEmptyWithoutParasitic: data.energyChargedSinceEmptyWithoutParasitic,
          energyChargedSinceFullWithoutParasitic: data.energyChargedSinceFullWithoutParasitic,
          energyDischargedSinceEmptyWithoutParasitic: data.energyDischargedSinceEmptyWithoutParasitic,
          assumedCapacity: capacity,
          assumedParasitic: parasitic,
          from: data.now,
          now: data.now,
        });

        if (socSinceEmpty == undefined || socSinceFull == undefined) {
          continue;
        }

        const diff = Math.abs(socSinceFull - socSinceEmpty);
        if (diff < 0.01) {
          const result: WorkerResult = { capacity, parasitic, sinceEmpty: socSinceEmpty, sinceFull: socSinceFull };
          results.push(result);
        }

        if (!bestResult || diff < Math.abs(bestResult.sinceFull - bestResult.sinceEmpty)) {
          bestResult = { capacity, parasitic, sinceEmpty: socSinceEmpty, sinceFull: socSinceFull };
        }
      }
    }

    // Refine the steps and search around the best result
    if (bestResult) {
      data.startCapacity = Math.max(data.startCapacity, bestResult.capacity - stepCapacity);
      data.endCapacity = Math.min(data.endCapacity, bestResult.capacity + stepCapacity);
      data.startParasitic = Math.max(data.startParasitic, bestResult.parasitic - stepParasitic);
      data.endParasitic = Math.min(data.endParasitic, bestResult.parasitic + stepParasitic);
    }

    stepCapacity = Math.floor(stepCapacity / 2);
    stepParasitic = Math.floor(stepParasitic / 2);
  }

  // Send all results that matched the criteria
  if (results.length > 0) {
    for (const result of results) {
      parentPort!.postMessage(result);
    }
  } else if (bestResult) {
    // If no result is close enough, send the best found
    parentPort!.postMessage(bestResult);
  }
}

optimizeCalculation(data);
