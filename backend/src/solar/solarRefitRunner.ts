import { fork } from "child_process";
import { performance } from "perf_hooks";
import process from "process";
import { fileURLToPath } from "url";
import type { SolarRefitChildReply } from "./solarRefitChild.ts";
import type { SolarRefitJob, SolarRefitJobResult } from "./solarRefitJob.ts";

/**
 * Runs a refit job in a short-lived child process. Measured on the VM with the real 2.5-year job:
 *  - a worker thread grew the controller's RSS by ~150 MB at peak and kept ~60 MB after it exited
 *    (glibc arenas of the dead thread are not returned), while
 *  - the same job in-process needs only ~45 MB (heap peak ~33 MB, typed arrays ~30 MB).
 * A child process isolates all of it: the controller's RSS and heap don't move, an out-of-memory
 * fit kills only the child, and everything is returned to the OS on exit. The heap cap below is
 * ~3× the measured peak. The child loads no npm package (InfluxDB over plain HTTP, open-meteo
 * parsed by hand), so it runs without Yarn PnP — about half the RSS of a PnP process.
 */
export function runSolarRefitInChildProcess(
  job: SolarRefitJob
): Promise<SolarRefitJobResult & { controller_spawn_ms: number }> {
  return new Promise((resolve, reject) => {
    const spawnStartedMs = performance.now();
    const child = fork(CHILD_ENTRY, [], {
      execArgv: [
        // The controller runs with --max-old-space-size=3072; the child gets its own, tight cap
        ...process.execArgv.filter(argument => !argument.startsWith("--max-old-space-size")),
        `--max-old-space-size=${CHILD_OLD_SPACE_LIMIT_MB}`,
        `--max-semi-space-size=${CHILD_SEMI_SPACE_LIMIT_MB}`,
      ],
      // No Yarn PnP in the child: its import graph is built-ins and relative modules only, and the
      // PnP runtime alone is ~40 MB of RSS
      // and none of the controller's UV_THREADPOOL_SIZE=32 (sized for the serial engine, #48): the
      // child's few file reads need libuv's default 4 threads
      env: { ...process.env, NODE_OPTIONS: "", UV_THREADPOOL_SIZE: "4" },
      serialization: "advanced",
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      finish();
    };
    const timeout = setTimeout(() => {
      settle(() =>
        reject(new Error(`solar refit child still running after ${CHILD_TIMEOUT_MS / 60_000} min — killed`))
      );
      child.kill("SIGKILL");
    }, CHILD_TIMEOUT_MS);
    child.once("message", (reply: SolarRefitChildReply) =>
      settle(() =>
        "error" in reply
          ? reject(new Error(`solar refit failed: ${reply.error}`))
          : resolve({ ...reply.result, controller_spawn_ms: spawnMs })
      )
    );
    child.once("error", error => settle(() => reject(error)));
    child.once("exit", (exitCode, signal) =>
      settle(() =>
        reject(
          new Error(`solar refit child exited (code ${exitCode}, signal ${signal}) before replying — out of memory?`)
        )
      )
    );
    child.send(job);
    // The only synchronous work the refit costs the controller's event loop besides judging the result
    const spawnMs = performance.now() - spawnStartedMs;
  });
}

const CHILD_ENTRY = fileURLToPath(new URL("./solarRefitChild.ts", import.meta.url));
export const CHILD_OLD_SPACE_LIMIT_MB = 96;
const CHILD_SEMI_SPACE_LIMIT_MB = 4;
/** Generous for a pegged pi Zero 2 W: minutes of Influx/open-meteo I/O plus ~1 s of fit on x64 */
const CHILD_TIMEOUT_MS = 30 * 60_000;
