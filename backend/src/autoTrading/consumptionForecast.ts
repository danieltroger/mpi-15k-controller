import Influx from "influx";
import { errorLog, logLog } from "../utilities/logging";

export type ConsumptionForecast = {
  /** Expected house load (AC output) in watts at a given time, excluding inverter parasitic draw */
  wattsAt: (ms: number) => number;
  source: "influx" | "fallback";
  fetchedAtMs: number;
  profile: number[];
};

let cache: ConsumptionForecast | undefined;

function localHour(ms: number): number {
  return parseInt(
    new Date(ms).toLocaleString("sv-SE", { timeZone: "Europe/Stockholm", hour: "2-digit", hour12: false }),
    10
  );
}

/**
 * Learn the house's typical consumption per local hour-of-day from the last 14 days of inverter data.
 * Median over days is used so that rare heavy loads (EV charging sessions) don't inflate the baseline —
 * those are exactly what the user handles manually via the extra-reserve knob.
 */
export async function fetchConsumptionForecast(
  influxClient: Influx.InfluxDB | undefined,
  fallbackWatts: number
): Promise<ConsumptionForecast> {
  const maxAgeMs = 12 * 3600 * 1000;
  if (cache && Date.now() - cache.fetchedAtMs < maxAgeMs && cache.source === "influx") return cache;

  let profile: number[] | undefined;
  if (influxClient) {
    try {
      // The influx client has no timeout of its own — don't let a hung connection stall callers forever
      const rows = (await Promise.race([
        influxClient.query(
          `SELECT mean(ac_output_total_active_power) as house FROM "mpp-solar" WHERE time > now() - 14d GROUP BY time(1h)`
        ),
        new Promise((_, reject) => setTimeout(() => reject(new Error("InfluxDB query timed out")), 45_000)),
      ])) as unknown as { time: { getNanoTime(): number }; house: number | null }[];
      const byHour: number[][] = Array.from({ length: 24 }, () => []);
      for (const row of rows) {
        if (row.house == null) continue;
        const ms = Math.round(row.time.getNanoTime() / 1e6);
        byHour[localHour(ms)].push(row.house);
      }
      if (byHour.some(bucket => bucket.length >= 3)) {
        profile = byHour.map(bucket => {
          if (!bucket.length) return fallbackWatts;
          const sorted = [...bucket].sort((a, b) => a - b);
          return sorted[Math.floor(sorted.length / 2)];
        });
        logLog("Learned consumption profile (W by local hour):", profile.map(w => Math.round(w)).join(","));
      }
    } catch (e) {
      errorLog("Failed to learn consumption profile from InfluxDB, using fallback", e);
    }
  }

  const finalProfile = profile ?? new Array(24).fill(fallbackWatts);
  cache = {
    wattsAt: ms => finalProfile[localHour(ms)],
    source: profile ? "influx" : "fallback",
    fetchedAtMs: Date.now(),
    profile: finalProfile,
  };
  return cache;
}
