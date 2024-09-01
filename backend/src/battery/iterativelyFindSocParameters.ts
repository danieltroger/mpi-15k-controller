import { Accessor, createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js";
import { get_config_object } from "../config";
import { SocWorkerData, WorkerResult } from "./socCalculationWorker.types";
import { error, log } from "../utilities/logging";
import { Worker } from "worker_threads";
import { appendFile } from "fs/promises";
import { useDatabasePower } from "./useDatabasePower";

export function iterativelyFindSocParameters({
  totalLastEmpty,
  totalLastFull,
  configSignal: [config, setConfig],
}: {
  totalLastFull: Accessor<number | undefined>;
  totalLastEmpty: Accessor<number | undefined>;
  configSignal: Awaited<ReturnType<typeof get_config_object>>;
}) {
  let effectsRunning = 0;
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
        databasePowerValues() !== undefined &&
        localPowerHistory().length)
  );
  // Calculate SOC stuff once an hour because the pi zero has so little ram it gets super slow when we do it
  setInterval(() => effectsRunning < 1 && setToggle(prev => !prev), 1000 * 60 * 60);

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

    effectsRunning++;
    onCleanup(() => {
      gotCleanuped = true;
      if (!decrementedRunning) {
        effectsRunning--;
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
        databasePowerValues: [...databasePowerValues()!],
        startCapacity,
        endCapacity,
        localPowerHistory: [...localPowerHistory()],
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
      if (workersRunning() === 0) {
        if (!decrementedRunning) {
          effectsRunning--;
          decrementedRunning = true;
        }
      }
      if (workersRunning() !== 0 || !results.length || gotCleanuped) return;
      const middleValue = getMiddleValue(results);
      log("Settling on", middleValue, "after doing SOC calculations");
      // Have these values in config so they persist over program restarts
      setConfig(prev => ({
        ...prev,
        soc_calculations: {
          ...prev.soc_calculations,
          current_state: {
            capacity: middleValue.capacity,
            parasitic_consumption: middleValue.parasitic,
          },
        },
      }));
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
