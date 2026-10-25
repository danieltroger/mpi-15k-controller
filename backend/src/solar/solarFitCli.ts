/**
 * Runs the monthly solar refit by hand, exactly as the controller would (child process: InfluxDB
 * history + open-meteo archives → fit; then the gates), and prints the result together with the
 * main thread's peak RSS and longest event-loop stall during the run. Read-only unless --write is
 * given, which persists backend/solar_model_state.json.
 *
 * Bootstrap a fresh pi from the VM, never on the pi itself (a second Node process holding a refit
 * next to the controller is too much for the 512 MB Zero 2 W), and copy the file BEFORE restarting
 * the controller on the new code — then its startup check finds a fresh fit and never refits:
 *   (VM, from backend/)  yarn node src/solar/solarFitCli.ts --write
 *   scp backend/solar_model_state.json ubuntu@<pi>:mpi-15k-controller/backend/
 * A file copied in later is still picked up within the hour (mtime check) and is never overwritten
 * by a refit that was already running.
 */
import { promises as fs_promises } from "fs";
import path from "path";
import process from "process";
import { monitorEventLoopDelay, performance } from "perf_hooks";
import { mergeWithDefaults } from "../config/config.ts";
import type { Config } from "../config/config.types.ts";
import { AZIMUTH_BIN_EDGES, ELEVATION_BIN_EDGES } from "./pvModel.ts";
import { refitSolarModel } from "./solarRefit.ts";
import { solarModelStatePath } from "./solarModelStore.ts";

const PROBE_INTERVAL_MS = 5;
const configPath = path.resolve(path.dirname(process.argv[1]), "../..", "config.json");
const config = mergeWithDefaults(
  JSON.parse(await fs_promises.readFile(configPath, { encoding: "utf-8" })) as Partial<Config>
);
const persist = process.argv.includes("--write");
const probe = startMainThreadProbe();
const { judgement, result, state, error, controllerBlockMs } = await refitSolarModel({
  config,
  nowMs: Date.now(),
  persist,
});
const mainThread = probe.stop();

if (error || !judgement || !result) {
  console.error("\n=== Solar refit FAILED ===", error);
  process.exit(1);
}
console.log(`\n=== Solar refit: ${judgement.accepted ? "ACCEPTED" : "REJECTED"} ===`);
for (const [kind, reasons] of Object.entries(judgement.pages)) {
  for (const reason of reasons ?? []) console.log(`  would page (P2, ${kind}):`, reason);
}
for (const reason of judgement.warnReasons) console.log("  warning:", reason);
console.log("  trailing year:", JSON.stringify(result.computation.trailing_year));
console.log(
  `  child: data ${result.load_ms} ms, fit ${result.compute_ms} ms, heap peak ${result.peak_heap_used_mb} MB, ` +
    `ArrayBuffers peak ${result.peak_array_buffers_mb} MB, RSS peak ${result.peak_rss_mb} MB | ` +
    `this process: RSS ${mainThread.baselineRssMb} → peak ${mainThread.peakRssMb} MB, event loop busy ${mainThread.activeMs} ms ` +
    `of the run, delay max ${mainThread.delayMaxMs} ms / p99 ${mainThread.delayP99Ms} ms | ` +
    `synchronous controller work: fork ${controllerBlockMs?.spawn} ms, judge ${controllerBlockMs?.judge} ms`
);
for (const stringKey of ["string1", "string2"] as const) {
  const { fit, level, capacity_change, mask_energy_change } = result.computation.strings[stringKey];
  const spec = config.automatic_trading.solar_model[stringKey];
  console.log(
    `\n${stringKey} (${spec.tilt_degrees}° / ${spec.azimuth_degrees}°, ${spec.nameplate_kwp} kWp): physical k ${fit.physical_k.toFixed(3)} ` +
      `(${((fit.physical_k / spec.nameplate_kwp) * 100).toFixed(0)} % of nameplate), sky ${fit.physical_sky_factor.toFixed(3)} | ` +
      `forecast k ${fit.forecast_k.toFixed(3)}, sky ${fit.forecast_sky_factor.toFixed(3)} | fit hours ${fit.fit_hours} | ` +
      `90-day level ${level.ratio?.toFixed(3) ?? "n/a"} (${level.modelled_kwh} kWh) | Δk ${capacity_change ?? "n/a"} | Δmask energy ${mask_energy_change ?? "n/a"}`
  );
  console.log(
    "az\\el " +
      ELEVATION_BIN_EDGES.slice(0, -1)
        .map(edge => String(edge).padStart(5))
        .join("")
  );
  fit.mask.forEach((row, azimuthBin) => {
    if (!fit.mask_sample_counts[azimuthBin]?.some(count => count > 0)) return;
    const cells = row.map((value, elevationBin) =>
      (fit.mask_sample_counts[azimuthBin][elevationBin] >= 6 ? value.toFixed(2) : ".").padStart(5)
    );
    console.log(String(AZIMUTH_BIN_EDGES[azimuthBin]).padStart(5) + " " + cells.join(""));
  });
}
console.log(
  persist
    ? `\nState written to ${solarModelStatePath()} (fit ${state.fit?.fitted_at ?? "none"})`
    : "\n(dry run — nothing written; pass --write to persist)"
);
process.exit(0);

/**
 * Measures this (controller-equivalent) process while the refit child runs: RSS peak, how long its
 * event loop was actually busy, and the event-loop delay histogram. On the QEMU VM the idle event
 * loop alone shows ~40–60 ms scheduling jitter, so the delay max is a noise floor, not a stall.
 */
function startMainThreadProbe() {
  const baselineRss = process.memoryUsage().rss;
  let peakRss = baselineRss;
  const utilizationStart = performance.eventLoopUtilization();
  const delays = monitorEventLoopDelay({ resolution: PROBE_INTERVAL_MS });
  delays.enable();
  const sampler = setInterval(() => (peakRss = Math.max(peakRss, process.memoryUsage().rss)), 20);
  return {
    stop: () => {
      clearInterval(sampler);
      delays.disable();
      const utilization = performance.eventLoopUtilization(utilizationStart);
      return {
        baselineRssMb: Math.round(baselineRss / 1e6),
        peakRssMb: Math.round(peakRss / 1e6),
        activeMs: Math.round(utilization.active),
        delayMaxMs: Math.round(delays.max / 1e6),
        delayP99Ms: Math.round(delays.percentile(99) / 1e6),
      };
    },
  };
}
