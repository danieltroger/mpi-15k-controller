import type Influx from "influx";
import type { Accessor } from "solid-js";
import { untrack } from "solid-js";
import type { Config } from "../config/config.types.ts";
import type { get_config_object } from "../config/config.ts";
import { errorLog, logLog } from "../utilities/logging.ts";
import { fetchRadiationByHour } from "./solarForecast.ts";

/** Trailing window of production history each re-fit is computed over */
const FIT_WINDOW_DAYS = 45;

export type SolarFitResult =
  | {
      ok: true;
      watts_per_direct_radiation: number;
      watts_per_diffuse_radiation: number;
      r2: number;
      samples: number;
    }
  | { ok: false; reason: string };

export type SolarFitSample = { direct: number; diffuse: number; pvWatts: number };

/**
 * Sun angles drift over the seasons, so the PV coefficients are re-fitted against actual
 * production every solar_model.refit_interval_days. Failures and implausible fits only log —
 * the previous coefficients keep working.
 */
export async function maybeRefitSolarModel(
  config: Accessor<Config>,
  setConfig: Awaited<ReturnType<typeof get_config_object>>[1],
  influxClient: Accessor<Influx.InfluxDB | undefined>
) {
  try {
    const tradingConfig = untrack(config).automatic_trading;
    const model = tradingConfig.solar_model;
    const intervalDays = model.refit_interval_days ?? 0;
    if (intervalDays <= 0) return;
    const lastFitMs = model.last_fitted_at ? +new Date(model.last_fitted_at) : 0;
    if (Date.now() - lastFitMs < intervalDays * 24 * 3600 * 1000) return;
    const client = influxClient();
    if (!client) return;

    logLog(`Auto trader: re-fitting solar model against the last ${FIT_WINDOW_DAYS} days of production`);
    const fit = await calibrateSolarModel(client, tradingConfig.latitude, tradingConfig.longitude, FIT_WINDOW_DAYS);
    if (!fit.ok) {
      errorLog("Auto trader: solar model refit not applied —", fit.reason);
      return;
    }
    const implausible = fitIsPlausibleVsCurrent(
      fit,
      model.watts_per_direct_radiation,
      model.watts_per_diffuse_radiation
    );
    if (implausible) {
      errorLog("Auto trader:", implausible);
      return;
    }
    setConfig(prev => ({
      ...prev,
      automatic_trading: {
        ...prev.automatic_trading,
        solar_model: {
          ...prev.automatic_trading.solar_model,
          watts_per_direct_radiation: fit.watts_per_direct_radiation,
          watts_per_diffuse_radiation: fit.watts_per_diffuse_radiation,
          last_fitted_at: new Date().toISOString(),
          fit_r2: fit.r2,
          fit_samples: fit.samples,
        },
      },
    }));
    logLog(
      `Auto trader: solar model refit applied — ${fit.watts_per_direct_radiation} W/(W/m²) direct + ${fit.watts_per_diffuse_radiation} diffuse (R²=${fit.r2}, n=${fit.samples})`
    );
  } catch (e) {
    errorLog("Auto trader: solar model refit failed (non-fatal)", e);
  }
}

/**
 * Pair hourly inverter PV averages from InfluxDB with open-meteo's radiation history for the same
 * hours, then least-squares fit pv_W ≈ a×direct_radiation + b×diffuse_radiation through the origin.
 */
export async function calibrateSolarModel(
  influxClient: Influx.InfluxDB,
  latitude: number,
  longitude: number,
  days: number
): Promise<SolarFitResult> {
  const pvWattsByHourMs = new Map<number, number>();
  const rows = (await Promise.race([
    influxClient.query(
      `SELECT mean(solar_input_power_1) as pv1, mean(solar_input_power_2) as pv2 FROM "mpp-solar" WHERE time > now() - ${days}d GROUP BY time(1h)`
    ),
    new Promise((_, reject) => setTimeout(() => reject(new Error("InfluxDB query timed out")), 60_000)),
  ])) as unknown as { time: { getNanoTime(): number }; pv1: number | null; pv2: number | null }[];
  for (const row of rows) {
    if (row.pv1 === null && row.pv2 === null) continue;
    const timestampMs = Math.round(row.time.getNanoTime() / 1e6);
    pvWattsByHourMs.set(Math.floor(timestampMs / 3600_000) * 3600_000, (row.pv1 ?? 0) + (row.pv2 ?? 0));
  }

  const radiationHours = await fetchRadiationByHour(latitude, longitude, { pastDays: days });
  const samples: SolarFitSample[] = [];
  for (const { hourMs, direct, diffuse } of radiationHours) {
    const pvWatts = pvWattsByHourMs.get(hourMs);
    if (pvWatts === undefined) continue;
    samples.push({ direct, diffuse, pvWatts });
  }
  return fitSolarModel(samples);
}

/** Pure least-squares fit (through the origin, two regressors). Exported for the self-test. */
export function fitSolarModel(samples: SolarFitSample[]): SolarFitResult {
  const daylightSamples = samples.filter(sample => sample.direct > 0 || sample.diffuse > 0);
  if (daylightSamples.length < 300) {
    return { ok: false, reason: `only ${daylightSamples.length} daylight samples, need 300` };
  }
  let sumDirectDirect = 0;
  let sumDiffuseDiffuse = 0;
  let sumDirectDiffuse = 0;
  let sumDirectPv = 0;
  let sumDiffusePv = 0;
  for (const { direct, diffuse, pvWatts } of daylightSamples) {
    sumDirectDirect += direct * direct;
    sumDiffuseDiffuse += diffuse * diffuse;
    sumDirectDiffuse += direct * diffuse;
    sumDirectPv += direct * pvWatts;
    sumDiffusePv += diffuse * pvWatts;
  }
  const determinant = sumDirectDirect * sumDiffuseDiffuse - sumDirectDiffuse * sumDirectDiffuse;
  if (!isFinite(determinant) || Math.abs(determinant) < 1e-3) {
    return { ok: false, reason: "degenerate radiation data (direct and diffuse collinear)" };
  }
  const wattsPerDirect = (sumDirectPv * sumDiffuseDiffuse - sumDiffusePv * sumDirectDiffuse) / determinant;
  const wattsPerDiffuse = (sumDirectDirect * sumDiffusePv - sumDirectDiffuse * sumDirectPv) / determinant;

  // Note: R² about the mean while the fit is through the origin — not a textbook goodness-of-fit
  // for no-intercept models, but a deliberately conservative accept/reject gate.
  const meanPvWatts = daylightSamples.reduce((sum, sample) => sum + sample.pvWatts, 0) / daylightSamples.length;
  let sumSquaresTotal = 0;
  let sumSquaresResidual = 0;
  for (const { direct, diffuse, pvWatts } of daylightSamples) {
    sumSquaresTotal += (pvWatts - meanPvWatts) ** 2;
    sumSquaresResidual += (pvWatts - wattsPerDirect * direct - wattsPerDiffuse * diffuse) ** 2;
  }
  const r2 = sumSquaresTotal > 0 ? 1 - sumSquaresResidual / sumSquaresTotal : 0;

  if (!(wattsPerDirect > 0.5 && wattsPerDirect < 200 && wattsPerDiffuse > 0.5 && wattsPerDiffuse < 200)) {
    return {
      ok: false,
      reason: `coefficients out of sane range (direct=${wattsPerDirect.toFixed(2)}, diffuse=${wattsPerDiffuse.toFixed(2)})`,
    };
  }
  if (r2 < 0.6) {
    return { ok: false, reason: `fit too poor (R²=${r2.toFixed(2)})` };
  }
  return {
    ok: true,
    watts_per_direct_radiation: Math.round(wattsPerDirect * 100) / 100,
    watts_per_diffuse_radiation: Math.round(wattsPerDiffuse * 100) / 100,
    r2: Math.round(r2 * 1000) / 1000,
    samples: daylightSamples.length,
  };
}

/** Sanity clamp: refuse to swing coefficients more than ±50% in one refit — that needs human eyes. */
export function fitIsPlausibleVsCurrent(
  fit: SolarFitResult,
  currentWattsPerDirect: number,
  currentWattsPerDiffuse: number
): string | undefined {
  if (!fit.ok) return undefined;
  const within = (next: number, current: number) => next >= current * 0.5 && next <= current * 1.5;
  if (
    !within(fit.watts_per_direct_radiation, currentWattsPerDirect) ||
    !within(fit.watts_per_diffuse_radiation, currentWattsPerDiffuse)
  ) {
    return `refit moved coefficients >50% (${currentWattsPerDirect}/${currentWattsPerDiffuse} → ${fit.watts_per_direct_radiation}/${fit.watts_per_diffuse_radiation}) — not applying, check panels/data`;
  }
  return undefined;
}
