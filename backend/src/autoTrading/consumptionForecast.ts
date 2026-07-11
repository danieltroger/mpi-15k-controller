import Influx from "influx";
import { errorLog, logLog, warnLog } from "../utilities/logging.ts";

export type ConsumptionForecast = {
  /** Expected house load (AC output) in watts at a given time, excluding inverter parasitic draw */
  wattsAt: (ms: number) => number;
  source: "influx" | "fallback";
  fetchedAtMs: number;
  profile: number[];
};

/** Constants for stripping water-heater consumption out of the learned history (see below) */
export type ElpatronHistoryKnobs = {
  element_watts: number;
  tank_wh_per_degree: number;
  tank_cooling_degrees_per_hour: number;
};

let cache: (ConsumptionForecast & { elpatronKey: string }) | undefined;

function localHour(ms: number): number {
  return parseInt(
    new Date(ms).toLocaleString("sv-SE", { timeZone: "Europe/Stockholm", hour: "2-digit", hourCycle: "h23" }),
    10
  );
}

/**
 * Learn the house's typical consumption per local hour-of-day from the last 14 days of inverter data.
 * Median over days is used so that rare heavy loads (EV charging sessions) don't inflate the baseline —
 * those are exactly what the user handles manually via the extra-reserve knob.
 *
 * When `subtractElpatron` is set (the water heater element is currently armed — see
 * elpatronForecast.ts), the element's share is stripped from each historical hour first, using the
 * tank sensor: energy into the tank ≈ heat capacity × (ΔT + standing loss). The planner adds the
 * element back as a modeled forward load, so leaving it in the baseline would double-count it.
 * Not applied in stove season (element unarmed), where tank warming is the pellet stove's doing.
 */
export async function fetchConsumptionForecast(
  influxClient: Influx.InfluxDB | undefined,
  fallbackWatts: number,
  subtractElpatron?: ElpatronHistoryKnobs
): Promise<ConsumptionForecast> {
  const maxAgeMs = 12 * 3600 * 1000;
  // Key the cache on the knob values too, so recalibrating them doesn't serve a stale profile
  const elpatronKey = JSON.stringify(subtractElpatron ?? null);
  if (
    cache &&
    Date.now() - cache.fetchedAtMs < maxAgeMs &&
    cache.source === "influx" &&
    cache.elpatronKey === elpatronKey
  ) {
    return cache;
  }

  let profile: number[] | undefined;
  if (influxClient) {
    try {
      // The influx client has no timeout of its own — don't let a hung connection stall callers forever
      const withTimeout = <T>(promise: Promise<T>) =>
        Promise.race([
          promise,
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("InfluxDB query timed out")), 45_000)),
        ]);
      const rows = (await withTimeout(
        influxClient.query(
          `SELECT mean(ac_output_total_active_power) as house FROM "mpp-solar" WHERE time > now() - 14d GROUP BY time(1h)`
        )
      )) as unknown as { time: { getNanoTime(): number }; house: number | null }[];

      const elpatronWByHourMs = subtractElpatron
        ? await estimateElpatronHistory(influxClient, subtractElpatron, withTimeout)
        : undefined;

      const byHour: number[][] = Array.from({ length: 24 }, () => []);
      let hoursWithTankData = 0;
      for (const row of rows) {
        if (row.house == null) continue;
        const ms = Math.round(row.time.getNanoTime() / 1e6);
        const elpatronW = elpatronWByHourMs?.get(ms);
        if (elpatronW !== undefined) hoursWithTankData++;
        // When the element dominates the hour (a burn, or night top-ups over a small base), the
        // residual is unmeasurable — drop the sample instead of feeding a fake 0 into the median
        if (elpatronW !== undefined && elpatronW > row.house * 0.9) continue;
        byHour[localHour(ms)].push(row.house - (elpatronW ?? 0));
      }
      if (elpatronWByHourMs && hoursWithTankData === 0) {
        // The subtraction silently doing nothing would double-count the element: it stays in this
        // learned baseline AND gets added by the forward model. Over-provisions the reserve
        // (the safe direction), but must be loud so a dead tank sensor gets noticed.
        warnLog(
          "Elpatron history subtraction found no usable tank data — learned baseline still contains the element and the forward model adds it again (over-forecast until the akkumulator sensor is back)"
        );
      }
      if (byHour.some(bucket => bucket.length >= 3)) {
        profile = byHour.map(bucket => {
          if (!bucket.length) return fallbackWatts;
          const sorted = [...bucket].sort((a, b) => a - b);
          return sorted[Math.floor(sorted.length / 2)];
        });
        logLog(
          `Learned consumption profile (W by local hour${subtractElpatron ? ", elpatron share removed" : ""}):`,
          profile.map(w => Math.round(w)).join(",")
        );
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
    elpatronKey,
  };
  return cache;
}

/**
 * Estimate the element's average watts for each historical hour from the tank sensor: energy in ≈
 * tank_wh_per_degree × (temperature rise + what standing loss ate). Hot-water usage hours show a
 * steep temperature DROP and clamp to 0; hours holding the thermostat band land near the standing
 * loss — both are what actually happened electrically, to within the calibration.
 *
 * Assumes the element is the ONLY thing heating the tank, which holds when this runs (armed ⇒
 * summer, pellet stove cold). Turning the element GPIO on manually DURING stove season would
 * misattribute stove heat to the element here and under-provision the baseline — if that ever
 * becomes a real combination, gate this on the stove being off (readable from the heating pi).
 */
async function estimateElpatronHistory(
  influxClient: Influx.InfluxDB,
  knobs: ElpatronHistoryKnobs,
  withTimeout: <T>(promise: Promise<T>) => Promise<T>
): Promise<Map<number, number>> {
  const rows = (await withTimeout(
    influxClient.query(
      `SELECT mean(akkumulator) as tank FROM "frendebo_thermometers" WHERE time > now() - 14d GROUP BY time(1h)`
    )
  )) as unknown as { time: { getNanoTime(): number }; tank: number | null }[];
  const hourMs = 3600 * 1000;
  const tankByMs = new Map<number, number>();
  for (const row of rows) {
    if (row.tank == null) continue;
    tankByMs.set(Math.round(row.time.getNanoTime() / 1e6), row.tank);
  }
  const elpatronWByMs = new Map<number, number>();
  for (const [ms, tank] of tankByMs) {
    const nextTank = tankByMs.get(ms + hourMs);
    if (nextTank === undefined) continue;
    const deltaDegrees = nextTank - tank;
    const estimatedW = knobs.tank_wh_per_degree * (deltaDegrees + knobs.tank_cooling_degrees_per_hour);
    elpatronWByMs.set(ms, Math.min(knobs.element_watts, Math.max(0, estimatedW)));
  }
  return elpatronWByMs;
}
