import { parentPort, workerData } from "worker_threads";
import { SocWorkerData, WorkerResult } from "./socCalculationWorker.types";
import { batteryCalculationsDependingOnUnknowns } from "./batteryCalculationsDependingOnUnknowns";
import { createRoot } from "solid-js";

const data: SocWorkerData = workerData;

function binarySearch(start: number, end: number, step: number, checkFunction: (mid: number) => number): number | null {
  while (start <= end) {
    const mid = Math.floor((start + end) / 2);
    const result = checkFunction(mid);
    if (result === 0) {
      return mid;
    } else if (result < 0) {
      start = mid + step;
    } else {
      end = mid - step;
    }
  }
  return null;
}

const findOptimalValues = (capacity: number, parasitic: number): number => {
  const { socSinceFull, socSinceEmpty } = createRoot(dispose => {
    const result = batteryCalculationsDependingOnUnknowns({
      now: () => data.now,
      localPowerHistory: () => data.localPowerHistory,
      databasePowerValues: () => data.databasePowerValues,
      totalLastFull: () => data.totalLastFull,
      totalLastEmpty: () => data.totalLastEmpty,
      subtractFromPower: () => parasitic,
      assumedCapacity: () => capacity,
      createMemo: fn => {
        // Squeeze some performance by not doing owner tracking, etc
        const val = fn();
        return () => val;
      },
    });
    dispose();
    return result;
  });
  const sinceFull = socSinceFull();
  const sinceEmpty = socSinceEmpty();
  if (sinceEmpty === undefined || sinceFull === undefined) {
    return 1; // Arbitrary non-zero value indicating an invalid result
  }
  return Math.abs(sinceFull - sinceEmpty) < 0.01 ? 0 : sinceFull - sinceEmpty;
};

// Binary search over capacities
const optimalCapacity = binarySearch(data.startCapacity, data.endCapacity, 1, capacity => {
  // Binary search over parasitic values for a given capacity
  const optimalParasitic = binarySearch(data.startParasitic, data.endParasitic, -1, parasitic => {
    return findOptimalValues(capacity, parasitic);
  });
  if (optimalParasitic !== null) {
    const result: WorkerResult = {
      capacity,
      parasitic: optimalParasitic,
      sinceEmpty: findOptimalValues(capacity, optimalParasitic),
      sinceFull: findOptimalValues(capacity, optimalParasitic),
    };
    parentPort!.postMessage(result);
    return 0; // Found optimal values
  }
  return 1; // Continue searching
});

if (optimalCapacity === null) {
  parentPort!.postMessage({ error: "No optimal values found" });
}
