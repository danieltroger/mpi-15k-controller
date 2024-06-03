import { Accessor, createEffect, createMemo, createSignal, onCleanup, Setter, untrack } from "solid-js";
import { Config } from "../config";
import { SocWorkerData, WorkerResult } from "./socCalculationWorker.types";
import { error, log } from "../utilities/logging";
import { Worker } from "worker_threads";
import { appendFile } from "fs/promises";

export function iterativelyFindSocParameters({
  config,
  totalLastEmpty,
  totalLastFull,
  now,
  localPowerHistory,
  databasePowerValues,
  setAssumedCapacity,
  setAssumedParasiticConsumption,
}: {
  config: Accessor<Config>;
  now: Accessor<number>;
  localPowerHistory: Accessor<{ value: number; time: number }[]>;
  databasePowerValues: Accessor<{ time: number; value: number }[]>;
  totalLastFull: Accessor<number | undefined>;
  totalLastEmpty: Accessor<number | undefined>;
  setAssumedParasiticConsumption: Setter<number>;
  setAssumedCapacity: Setter<number>;
}) {
  let running = 0;
  const numWorkers = 1; // Hardcoded for now
  const startCapacityWh = createMemo(
    () => config().soc_calculations.capacity_per_cell_from_wh * config().soc_calculations.number_of_cells
  );
  const endCapacityWh = createMemo(
    () => config().soc_calculations.capacity_per_cell_to_wh * config().soc_calculations.number_of_cells
  );
  const [toggle, setToggle] = createSignal(false);
  const startParasiticConsumption = createMemo(() => config().soc_calculations.parasitic_consumption_from);
  const endParasiticConsumption = createMemo(() => config().soc_calculations.parasitic_consumption_to);
  const hasData = createMemo<boolean | number | undefined>(
    prev =>
      prev ||
      (totalLastFull() !== undefined &&
        totalLastEmpty() !== undefined &&
        databasePowerValues().length &&
        localPowerHistory().length)
  );
  // Calculate SOC stuff all the time, check every minute essentially if it's time to do it again
  setInterval(() => running < 1 && setToggle(prev => !prev), 1000 * 60);

  createEffect(() => {
    if (!hasData()) return;
    toggle();
    const totalStartCapacity = startCapacityWh();
    const totalEndCapacity = endCapacityWh();
    const startParasitic = startParasiticConsumption();
    const endParasitic = endParasiticConsumption();
    const rangePerWorker = Math.ceil((totalEndCapacity - totalStartCapacity) / numWorkers);
    const [workersRunning, setWorkersRunning] = createSignal(0);
    const results: WorkerResult[] = [];
    const fileForRun = new URL(`../socCalculationLog-${new Date().toISOString()}.txt`, import.meta.url);
    let gotCleanuped = false;
    let decrementedRunning = false;

    running++;
    onCleanup(() => {
      gotCleanuped = true;
      if (!decrementedRunning) {
        running--;
        decrementedRunning = true;
      }
    });

    log("Spawning", numWorkers, "workers to figure out SOC requirements");

    for (let i = 0; i < numWorkers; i++) {
      const startCapacity = totalStartCapacity + i * rangePerWorker;
      const endCapacity = Math.min(startCapacity + rangePerWorker - 1, totalEndCapacity);

      const workerData: SocWorkerData = untrack(() => ({
        now: now(),
        totalLastEmpty: totalLastEmpty(),
        totalLastFull: totalLastFull(),
        endParasitic,
        startParasitic,
        databasePowerValues: databasePowerValues(),
        startCapacity,
        endCapacity,
        localPowerHistory: localPowerHistory(),
      }));

      const worker = new Worker(new URL("./socCalculationWorker.ts", import.meta.url), {
        workerData,
      });
      setWorkersRunning(prev => prev + 1);

      worker.on("message", (result: WorkerResult) => {
        appendFile(fileForRun, JSON.stringify({ ...result, time: +new Date() }) + "\n", "utf-8").catch(e =>
          error("Failed to write soc calculation log", e)
        );
        results.push(result);
      });

      worker.on("error", err => {
        error(`Worker ${i} error:`, err);
        worker.terminate();
      });

      worker.on("exit", code => {
        setWorkersRunning(prev => prev - 1);
        if (code !== 0) {
          error(`Worker ${i} stopped with exit code ${code}`);
        } else {
          log(`Worker ${i} is done`);
        }
      });

      onCleanup(() => worker.terminate());
    }

    createEffect(() => {
      if (workersRunning() !== 0 || !results.length || gotCleanuped) return;
      const middleValue = getMiddleValue(results);
      log("Settling on", middleValue, "after doing SOC calculations");
      setAssumedCapacity(middleValue.capacity);
      setAssumedParasiticConsumption(middleValue.parasitic);
      if (!decrementedRunning) {
        running--;
        decrementedRunning = true;
      }
    });
  });
}

function getMiddleValue(data: WorkerResult[]): WorkerResult {
  // Calculate the average of sinceEmpty and sinceFull for each data point
  const withAverage = data.map(point => ({ ...point, average: (point.sinceEmpty + point.sinceFull) / 2 }));

  // Sort the data points by the average value
  withAverage.sort((a, b) => a.average - b.average);

  // Get the middle index
  const middleIndex = Math.floor(withAverage.length / 2);

  // Return the middle value
  return data[middleIndex];
}
