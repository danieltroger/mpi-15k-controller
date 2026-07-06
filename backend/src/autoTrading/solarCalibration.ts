import type Influx from "influx";

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
 * Re-fit the PV production model (pv_W ≈ a×direct_radiation + b×diffuse_radiation) against what the
 * panels actually produced. Pairs hourly inverter PV averages from InfluxDB with open-meteo's
 * radiation history for the same hours, then least-squares fits through the origin. Sun angles
 * change over the seasons, so this runs periodically (automatic_trading.solar_model.refit_interval_days).
 */
export async function calibrateSolarModel(
  influxClient: Influx.InfluxDB,
  latitude: number,
  longitude: number,
  days: number
): Promise<SolarFitResult> {
  const pvByHourMs = new Map<number, number>();
  const rows = (await Promise.race([
    influxClient.query(
      `SELECT mean(solar_input_power_1) as pv1, mean(solar_input_power_2) as pv2 FROM "mpp-solar" WHERE time > now() - ${days}d GROUP BY time(1h)`
    ),
    new Promise((_, reject) => setTimeout(() => reject(new Error("InfluxDB query timed out")), 60_000)),
  ])) as unknown as { time: { getNanoTime(): number }; pv1: number | null; pv2: number | null }[];
  for (const row of rows) {
    if (row.pv1 === null && row.pv2 === null) continue;
    const ms = Math.round(row.time.getNanoTime() / 1e6);
    pvByHourMs.set(Math.floor(ms / 3600_000) * 3600_000, (row.pv1 ?? 0) + (row.pv2 ?? 0));
  }

  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(latitude));
  url.searchParams.set("longitude", String(longitude));
  url.searchParams.set("hourly", "direct_radiation,diffuse_radiation");
  url.searchParams.set("past_days", String(Math.min(days, 92)));
  url.searchParams.set("forecast_days", "1");
  url.searchParams.set("timezone", "UTC");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  let data: any;
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Weather API returned ${response.status}`);
    data = await response.json();
  } finally {
    clearTimeout(timeout);
  }

  const samples: SolarFitSample[] = [];
  const times: string[] = data.hourly.time;
  for (let i = 0; i < times.length; i++) {
    const pv = pvByHourMs.get(+new Date(times[i] + ":00Z"));
    const direct = data.hourly.direct_radiation[i];
    const diffuse = data.hourly.diffuse_radiation[i];
    if (pv === undefined || direct === null || diffuse === null) continue;
    samples.push({ direct, diffuse, pvWatts: pv });
  }
  return fitSolarModel(samples);
}

/** Pure least-squares fit (through the origin, two regressors). Exported for the self-test. */
export function fitSolarModel(samples: SolarFitSample[]): SolarFitResult {
  const daylight = samples.filter(s => s.direct > 0 || s.diffuse > 0);
  if (daylight.length < 300) {
    return { ok: false, reason: `only ${daylight.length} daylight samples, need 300` };
  }
  let Sdd = 0,
    Sff = 0,
    Sdf = 0,
    Sdp = 0,
    Sfp = 0;
  for (const { direct: d, diffuse: f, pvWatts: p } of daylight) {
    Sdd += d * d;
    Sff += f * f;
    Sdf += d * f;
    Sdp += d * p;
    Sfp += f * p;
  }
  const det = Sdd * Sff - Sdf * Sdf;
  if (!isFinite(det) || Math.abs(det) < 1e-3) {
    return { ok: false, reason: "degenerate radiation data (direct and diffuse collinear)" };
  }
  const a = (Sdp * Sff - Sfp * Sdf) / det;
  const b = (Sdd * Sfp - Sdf * Sdp) / det;

  const mean = daylight.reduce((s, x) => s + x.pvWatts, 0) / daylight.length;
  let ssTot = 0,
    ssRes = 0;
  for (const { direct: d, diffuse: f, pvWatts: p } of daylight) {
    ssTot += (p - mean) ** 2;
    ssRes += (p - a * d - b * f) ** 2;
  }
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;

  if (!(a > 0.5 && a < 200 && b > 0.5 && b < 200)) {
    return { ok: false, reason: `coefficients out of sane range (a=${a.toFixed(2)}, b=${b.toFixed(2)})` };
  }
  if (r2 < 0.6) {
    return { ok: false, reason: `fit too poor (R²=${r2.toFixed(2)})` };
  }
  return {
    ok: true,
    watts_per_direct_radiation: Math.round(a * 100) / 100,
    watts_per_diffuse_radiation: Math.round(b * 100) / 100,
    r2: Math.round(r2 * 1000) / 1000,
    samples: daylight.length,
  };
}

/** Sanity clamp: refuse to swing coefficients more than ±50% in one refit — that needs human eyes. */
export function fitIsPlausibleVsCurrent(fit: SolarFitResult, currentA: number, currentB: number): string | undefined {
  if (!fit.ok) return undefined;
  const within = (next: number, current: number) => next >= current * 0.5 && next <= current * 1.5;
  if (!within(fit.watts_per_direct_radiation, currentA) || !within(fit.watts_per_diffuse_radiation, currentB)) {
    return `refit moved coefficients >50% (${currentA}/${currentB} → ${fit.watts_per_direct_radiation}/${fit.watts_per_diffuse_radiation}) — not applying, check panels/data`;
  }
  return undefined;
}
