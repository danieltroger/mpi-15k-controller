import { useCurrentPower } from "./useCurrentPower";
import { useNow } from "./utilities/useNow";
import { useDatabasePower } from "./useDatabasePower";
import { Accessor, createEffect, createMemo, createSignal, onCleanup, Setter, untrack } from "solid-js";
import { useMQTTValues } from "./useMQTTValues";
import { Config, get_config_object } from "./config";
import { Worker } from "worker_threads";
import { cpus } from "os";
import { batteryCalculationsDependingOnUnknowns } from "./batteryCalculationsDependingOnUnknowns";
import { SocWorkerData, WorkerResult } from "./socCalculationWorker.types";
import { error, log } from "./utilities/logging";
import { appendFile } from "fs/promises";

export function useBatteryValues(
  mqttValues: ReturnType<typeof useMQTTValues>["mqttValues"],
  configSignal: Awaited<ReturnType<typeof get_config_object>>
) {
  const [config] = configSignal;
  const {
    localPowerHistory,
    currentPower,
    lastBatterySeenFullSinceProgramStart,
    lastBatterySeenEmptySinceProgramStart,
  } = useCurrentPower(mqttValues, configSignal);
  const now = useNow();
  const { databasePowerValues, batteryWasLastFullAtAccordingToDatabase, batteryWasLastEmptyAtAccordingToDatabase } =
    useDatabasePower(configSignal);

  const [totalLastFull, totalLastEmpty] = [
    [batteryWasLastFullAtAccordingToDatabase, lastBatterySeenFullSinceProgramStart],
    [batteryWasLastEmptyAtAccordingToDatabase, lastBatterySeenEmptySinceProgramStart],
  ].map(([db, local]) =>
    createMemo(() => {
      const lastSinceStart = local();
      const lastAccordingToDatabase = db();
      if (!lastSinceStart && !lastAccordingToDatabase) return;
      if (!lastSinceStart) return lastAccordingToDatabase;
      if (!lastAccordingToDatabase) return lastSinceStart;
      return Math.max(lastSinceStart, lastAccordingToDatabase);
    })
  );
  const [assumedParasiticConsumption, setAssumedParasiticConsumption] = createSignal(315);
  const [assumedCapacity, setAssumedCapacity] = createSignal(19.2 * 12 * 3 * 16);

  const {
    energyAddedSinceEmpty,
    energyChargedSinceEmpty,
    energyDischargedSinceEmpty,
    energyDischargedSinceFull,
    energyRemovedSinceFull,
    energyChargedSinceFull,
    socSinceFull,
    socSinceEmpty,
  } = batteryCalculationsDependingOnUnknowns({
    now,
    localPowerHistory,
    databasePowerValues,
    totalLastFull,
    totalLastEmpty,
    subtractFromPower: assumedParasiticConsumption,
    assumedCapacity,
  });

  iterativelyFindSocParameters({
    config,
    totalLastEmpty,
    totalLastFull,
    now,
    localPowerHistory,
    databasePowerValues,
    setAssumedCapacity,
    setAssumedParasiticConsumption,
  });

  return {
    energyChargedSinceFull,
    energyChargedSinceEmpty,
    energyDischargedSinceEmpty,
    energyDischargedSinceFull,
    currentPower,
    totalLastEmpty,
    totalLastFull,
    energyRemovedSinceFull,
    energyAddedSinceEmpty,
    socSinceEmpty,
    socSinceFull,
    assumedCapacity,
    assumedParasiticConsumption,
  };
}

function iterativelyFindSocParameters({
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
  const numWorkers = cpus().length - 1; // Leave a CPU for the main thread
  const startCapacityWh = createMemo(
    () => config().soc_calculations.capacity_per_cell_from_wh * config().soc_calculations.number_of_cells
  );
  const endCapacityWh = createMemo(
    () => config().soc_calculations.capacity_per_cell_to_wh * config().soc_calculations.number_of_cells
  );
  const [toggle, setToggle] = createSignal(false);
  const startParasiticConsumption = createMemo(() => config().soc_calculations.parasitic_consumption_from);
  const endParasiticConsumption = createMemo(() => config().soc_calculations.parasitic_consumption_to);
  // Calculate SOC stuff once an hour
  setInterval(() => setToggle(prev => !prev), 1000 * 60 * 60);

  createEffect(() => {
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

    onCleanup(() => (gotCleanuped = true));

    log("Spawning ", numWorkers, "workers to figure out SOC requirements");

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
