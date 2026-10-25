import { Worker } from "worker_threads";
import type { SolarRefitInput, SolarRefitOutput } from "./solarRefitComputation.ts";

/** Runs computeSolarRefit in a worker thread (inherits the parent's execArgv, so the PnP loader too). */
export function runSolarRefitInWorker(input: SolarRefitInput): Promise<SolarRefitOutput> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./solarFitWorker.ts", import.meta.url), { workerData: input });
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      finish();
    };
    const timeout = setTimeout(() => {
      settle(() => reject(new Error(`solar refit worker still running after ${WORKER_TIMEOUT_MS / 60_000} min`)));
      void worker.terminate();
    }, WORKER_TIMEOUT_MS);
    worker.once("message", (output: SolarRefitOutput) => settle(() => resolve(output)));
    worker.once("error", error => settle(() => reject(error)));
    worker.once("exit", exitCode =>
      settle(() => reject(new Error(`solar refit worker exited with code ${exitCode} before replying`)))
    );
  });
}

/** Generous for a pegged pi Zero 2 W; the fit takes ~0.5 s on a desktop core */
const WORKER_TIMEOUT_MS = 20 * 60_000;
