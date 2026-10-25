import process from "process";
import { describeError } from "./errorDescription.ts";
import { runSolarRefitJob, type SolarRefitJob } from "./solarRefitJob.ts";

/**
 * Child-process entry for the monthly refit (see solarRefitRunner.ts for why a process, not a
 * worker thread): receives one job over IPC, runs the history read, dataset and fit, replies with
 * the small result and exits — returning every byte to the OS.
 */
if (!process.send) throw new Error("solarRefitChild.ts must be forked with an IPC channel (see solarRefitRunner.ts)");
process.once("message", async (job: SolarRefitJob) => {
  let reply: SolarRefitChildReply;
  try {
    reply = { result: await runSolarRefitJob(job) };
  } catch (error) {
    // The cause chain, not the stack: the controller logs (and pages) this string
    reply = { error: describeError(error) };
  }
  process.send?.(reply, () => process.exit(0));
});

export type SolarRefitChildReply = { result: Awaited<ReturnType<typeof runSolarRefitJob>> } | { error: string };
