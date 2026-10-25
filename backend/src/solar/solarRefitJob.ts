import type { Config, SolarModelConfig } from "../config/config.types.ts";
import { fetchRadiationArchiveColumns, type RadiationArchiveSource } from "./openMeteoClient.ts";
import { describeError } from "./errorDescription.ts";
import { influxHttpQuery } from "./influxQuery.ts";
import { queryPvHistory } from "./pvHistory.ts";
import { buildSolarFitDataset } from "./solarFitDataset.ts";
import { computeSolarRefit, type SolarRefitOutput } from "./solarRefitComputation.ts";
import { stringGeometries } from "./solarModelGeometry.ts";
import type { SolarModelFit } from "./solarModel.types.ts";

/**
 * The whole heavy half of a refit, run INSIDE the refit child process: the 2.5-year history read
 * from InfluxDB, both irradiance archives, the dataset and the fit. The controller (whose event
 * loop drives the inverter's serial port, see #48) only sends these parameters and gets the small
 * result back — no history, arrays or parsing ever touch its event loop or heap.
 */
export async function runSolarRefitJob(job: SolarRefitJob): Promise<SolarRefitJobResult> {
  const memory = new PeakMemory();
  const startedAtMs = Date.now();
  const fromMs = Date.parse(job.solar_model.history_start);
  if (!Number.isFinite(fromMs))
    throw new Error(`solar_model.history_start "${job.solar_model.history_start}" is not a date`);
  const toMs = Math.floor(job.nowMs / 3600_000) * 3600_000;

  const history = await queryPvHistory(influxHttpQuery(job.influxdb), fromMs, toMs);
  memory.sample();
  const grid = {
    latitude: job.latitude,
    longitude: job.longitude,
    firstHourMs: history.firstHourMs,
    hourCount: history.hourCount,
  };
  const forecast = await fetchRadiationArchiveColumns({ source: "forecast_archive", ...grid });
  const { physical, maskSource, satelliteError } = await fetchPhysicalColumns(
    job.solar_model.mask_irradiance_source,
    forecast,
    grid
  );
  memory.sample();
  const { dataset, completeHours } = buildSolarFitDataset({
    history,
    physical,
    forecast,
    latitude: job.latitude,
    longitude: job.longitude,
    rewiredAtMs: job.solar_model.rewired_at ? Date.parse(job.solar_model.rewired_at) : Number.NaN,
    full_battery_voltage: job.full_battery_voltage,
  });
  memory.sample();
  const loadedAtMs = Date.now();
  const computation = computeSolarRefit({
    dataset,
    geometry: stringGeometries(job.solar_model),
    nowMs: job.nowMs,
    mask_half_life_days: job.solar_model.mask_half_life_days,
    incumbent: job.incumbent,
  });
  memory.sample();
  return {
    computation,
    coverage: coverageOf(dataset.hourStartMs, completeHours, job.nowMs),
    mask_irradiance_source: maskSource,
    satellite_error: satelliteError,
    load_ms: loadedAtMs - startedAtMs,
    compute_ms: Date.now() - loadedAtMs,
    peak_heap_used_mb: memory.heapUsedMb,
    peak_array_buffers_mb: memory.arrayBuffersMb,
    peak_rss_mb: memory.rssMb,
  };
}

export type SolarRefitJob = {
  influxdb: NonNullable<Config["influxdb"]>;
  latitude: number;
  longitude: number;
  solar_model: SolarModelConfig;
  full_battery_voltage: number;
  nowMs: number;
  incumbent: SolarModelFit | undefined;
};

export type SolarRefitJobResult = {
  computation: SolarRefitOutput;
  coverage: { recentCompleteShare: number; completeDays: number };
  mask_irradiance_source: SolarModelFit["mask_irradiance_source"];
  /** Why the satellite archive was skipped (the fit then used the forecast archive) */
  satellite_error?: string;
  load_ms: number;
  compute_ms: number;
  /** The child's heap, ArrayBuffer and RSS peaks at the job's stage boundaries */
  peak_heap_used_mb: number;
  peak_array_buffers_mb: number;
  peak_rss_mb: number;
};

/** Satellite by default; the forecast archive if the satellite API fails (backtest: costs ±0.5 %). */
async function fetchPhysicalColumns(
  preferred: RadiationArchiveSource,
  forecast: Awaited<ReturnType<typeof fetchRadiationArchiveColumns>>,
  grid: { latitude: number; longitude: number; firstHourMs: number; hourCount: number }
) {
  if (preferred === "forecast_archive") return { physical: forecast, maskSource: "forecast_archive" as const };
  try {
    return {
      physical: await fetchRadiationArchiveColumns({ source: "satellite", ...grid }),
      maskSource: "satellite" as const,
    };
  } catch (error) {
    // Reported by the controller (warnLog) — this module runs in the refit child process
    return { physical: forecast, maskSource: "forecast_archive" as const, satelliteError: describeError(error) };
  }
}

function coverageOf(hourStartMs: Float64Array, completeHours: Uint8Array, nowMs: number) {
  const recentFromMs = nowMs - 60 * 86_400_000;
  let recentHours = 0;
  let recentComplete = 0;
  let complete = 0;
  hourStartMs.forEach((startMs, hour) => {
    complete += completeHours[hour];
    if (startMs < recentFromMs) return;
    recentHours += 1;
    recentComplete += completeHours[hour];
  });
  return {
    recentCompleteShare: recentHours ? recentComplete / recentHours : 0,
    completeDays: Math.floor(complete / 24),
  };
}

class PeakMemory {
  heapUsedMb = 0;
  arrayBuffersMb = 0;
  rssMb = 0;
  sample() {
    const usage = process.memoryUsage();
    this.heapUsedMb = Math.max(this.heapUsedMb, Math.round(usage.heapUsed / 1e6));
    this.arrayBuffersMb = Math.max(this.arrayBuffersMb, Math.round(usage.arrayBuffers / 1e6));
    this.rssMb = Math.max(this.rssMb, Math.round(usage.rss / 1e6));
  }
}
