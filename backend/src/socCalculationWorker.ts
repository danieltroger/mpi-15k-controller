import { parentPort, workerData } from "worker_threads";
import { SocWorkerData, WorkerResult } from "./socCalculationWorker.types";
import { batteryCalculationsDependingOnUnknowns } from "./batteryCalculationsDependingOnUnknowns";
import { createRoot } from "solid-js";

const data: SocWorkerData = workerData;

doWork: {
  for (let capacity = data.startCapacity; capacity <= data.endCapacity; capacity += 1) {
    for (let parasitic = data.endParasitic; parasitic >= data.startParasitic; parasitic -= 1) {
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
            // Squeeze some performance by not do owner tracking, etc
            const val = fn();
            return () => val;
          },
        });
        // We don't want calculateSoc to do any reactive stuff in this case so we just give it its own root and instantly dispose it after the first run, unsure how much overhead this adds
        dispose();
        return result;
      });
      const sinceFull = socSinceFull();
      const sinceEmpty = socSinceEmpty();
      if (sinceEmpty == undefined || sinceFull == undefined) {
        break doWork;
      }
      if (Math.abs(sinceFull - sinceEmpty) < 0.01) {
        const result: WorkerResult = { capacity, parasitic, sinceEmpty, sinceFull };
        parentPort!.postMessage(result);
        break;
      }
    }
  }
}
