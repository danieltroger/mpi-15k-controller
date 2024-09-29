import { Accessor, createEffect, createMemo, createSignal, getOwner, onCleanup, runWithOwner, untrack } from "solid-js";
import { get_config_object } from "../config";
import { SocWorkerData, WorkerResponse, WorkerResult } from "./socCalculationWorker.types";
import { error, log } from "../utilities/logging";
import { Worker } from "worker_threads";
import { appendFile } from "fs/promises";
import { useNow } from "../utilities/useNow";
import { random_string } from "@depict-ai/utilishared/latest";

export function iterativelyFindSocParameters({
  totalLastEmpty,
  totalLastFull,
  configSignal: [config, setConfig],
  energyWithoutParasiticSinceEmpty,
  energyWithoutParasiticSinceFull,
}: {
  totalLastFull: Accessor<number | undefined>;
  totalLastEmpty: Accessor<number | undefined>;
  configSignal: Awaited<ReturnType<typeof get_config_object>>;
  energyWithoutParasiticSinceEmpty: Accessor<undefined | number>;
  energyWithoutParasiticSinceFull: Accessor<undefined | number>;
}) {
  let workerReady = false;
  let encounteredBusy = false;
  const owner = getOwner();
  const startCapacityWh = createMemo(
    () => config().soc_calculations.capacity_per_cell_from_wh * config().soc_calculations.number_of_cells
  );
  const endCapacityWh = createMemo(
    () => config().soc_calculations.capacity_per_cell_to_wh * config().soc_calculations.number_of_cells
  );
  const [toggle, setToggle] = createSignal(false);
  const startParasiticConsumption = createMemo(() => config().soc_calculations.parasitic_consumption_from);
  const endParasiticConsumption = createMemo(() => config().soc_calculations.parasitic_consumption_to);
  const hasData = createMemo(
    () =>
      totalLastFull() !== undefined &&
      totalLastEmpty() !== undefined &&
      energyWithoutParasiticSinceFull() !== undefined &&
      energyWithoutParasiticSinceEmpty() !== undefined
  );
  log("Starting worker for SOC calculations");
  const worker = new Worker(new URL("./socCalculationWorker.ts", import.meta.url));

  worker.on("message", (message: WorkerResponse) => {
    if (message.started) {
      workerReady = true;
      encounteredBusy = false;
      setToggle(prev => !prev);
    }
  });
  worker.on("error", err => {
    error(`Worker error:`, err);
    worker.terminate();
    runWithOwner(owner, () => {
      throw new Error("Worker error, see previous log");
    });
  });
  worker.on("exit", code => error(`Worker stopped with exit code ${code}, which shouldn't happen`));
  onCleanup(() => worker.terminate());

  // Calculate SOC stuff every 10 minutes
  setInterval(() => setToggle(prev => !prev), 1000 * 60 * 10);

  createEffect(() => {
    toggle();
    if (!hasData()) return;
    if (!workerReady) {
      encounteredBusy = true;
      return;
    }
    const startCapacity = startCapacityWh();
    const endCapacity = endCapacityWh();
    const startParasitic = startParasiticConsumption();
    const endParasitic = endParasiticConsumption();
    const results: WorkerResult[] = [];
    const fileForRun = new URL(`../socCalculationLog-${new Date().toISOString()}.txt`, import.meta.url);
    const jobId = random_string();

    const workerData: SocWorkerData = untrack(() => ({
      totalLastEmpty: totalLastEmpty()!,
      totalLastFull: totalLastFull()!,
      endParasitic,
      startParasitic,
      startCapacity,
      endCapacity,
      energyWithoutParasiticSinceEmpty: energyWithoutParasiticSinceEmpty()!,
      energyWithoutParasiticSinceFull: energyWithoutParasiticSinceFull()!,
      now: useNow(),
      jobId,
    }));

    worker.postMessage(workerData);
    workerReady = false;

    const messageHandler = (result: WorkerResponse) => {
      if (result.jobId !== jobId) return;
      if (result.done) {
        if (results.length) {
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
        } else {
          log("No results from SOC calculations, keeping current values");
        }

        worker.off("message", messageHandler);
        workerReady = true;
        if (encounteredBusy) {
          encounteredBusy = false;
          setToggle(prev => !prev);
        }
        return;
      }
      appendFile(fileForRun, JSON.stringify({ ...result, time: +new Date() }) + "\n", "utf-8").catch(e =>
        error("Failed to write soc calculation log", e)
      );
      results.push(result);
    };

    worker.on("message", messageHandler);
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
