import { parentPort, workerData } from "worker_threads";
import { computeSolarRefit, type SolarRefitInput } from "./solarRefitComputation.ts";

/**
 * Worker-thread entry for the monthly refit: tens of seconds of number crunching on the pi
 * Zero 2 W, kept off the event loop that drives the inverter. A throw here surfaces as the
 * worker's "error" event in solarFitRunner.ts.
 */
if (!parentPort) throw new Error("solarFitWorker.ts must run as a worker thread (see solarFitRunner.ts)");
parentPort.postMessage(computeSolarRefit(workerData as SolarRefitInput));
