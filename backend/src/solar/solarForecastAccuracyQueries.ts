import type Influx from "influx";
import type { AutomaticTradingConfig } from "../config/config.types.ts";
import { localDateStr } from "../autoTrading/tradingPerformance.ts";
import { sunPosition } from "../utilities/sunPosition.ts";
import { fetchLiveRadiation } from "./openMeteoClient.ts";
import { influxClientQuery } from "./influxQuery.ts";
import { queryPvHistory } from "./pvHistory.ts";
import { SUBSTEPS_PER_HOUR } from "./pvModel.ts";
import { isStalledBin } from "./pvStall.ts";
import { snowGateFlags } from "./snowGate.ts";
import type { DailyForecastAccuracy } from "./solarForecastAccuracyRule.ts";

/** The InfluxDB / open-meteo reads behind the daily accuracy settlement (solarForecastAccuracy.ts). */
export type StringWattsByHour = Map<number, { string1: number; string2: number }>;

export function sumKwh(byHour: StringWattsByHour, stringKey: "string1" | "string2"): number {
  let watts = 0;
  for (const hour of byHour.values()) if (Number.isFinite(hour[stringKey])) watts += hour[stringKey];
  return watts / 1000;
}

export async function queryForecastHours(
  influxClient: Influx.InfluxDB,
  lead: "short" | "day_ahead",
  startMs: number,
  endMs: number
): Promise<StringWattsByHour> {
  const rows = await influxClient.query<{ time: Date; string1_w: number; string2_w: number }>(
    `SELECT last(string1_w) AS string1_w, last(string2_w) AS string2_w FROM solar_forecast WHERE "lead" = '${lead}' AND time >= ${startMs}ms AND time < ${endMs}ms GROUP BY time(1h) fill(none)`
  );
  return new Map(rows.map(row => [row.time.getTime(), { string1: row.string1_w, string2: row.string2_w }]));
}

/** Bins with the "PV stalled" signature over the day — an outage day doesn't judge the forecast */
export async function countStalledBins(
  influxClient: Influx.InfluxDB,
  startMs: number,
  endMs: number,
  location: Pick<AutomaticTradingConfig, "latitude" | "longitude">
): Promise<number> {
  const history = await queryPvHistory(influxClientQuery(influxClient), startMs, endMs);
  let stalled = 0;
  for (let bin = 0; bin < history.hourCount * SUBSTEPS_PER_HOUR; bin++) {
    const binMidMs = history.firstHourMs + bin * 600_000 + 300_000;
    const stalledBin = isStalledBin({
      mppt1Watts: history.mppt1Watts[bin],
      mppt2Watts: history.mppt2Watts[bin],
      mppt1Volts: history.mppt1Volts[bin],
      mppt2Volts: history.mppt2Volts[bin],
      sunElevationDegrees: sunPosition(binMidMs, location.latitude, location.longitude).apparentElevationDegrees,
    });
    if (stalledBin) stalled += 1;
  }
  return stalled;
}

/**
 * Was the snow gate open at any hour of [startMs, endMs)? From the live forecast's own recent
 * history (past_days), the same snow variables the nowcast gates on.
 */
export async function snowGatedDuring(
  location: Pick<AutomaticTradingConfig, "latitude" | "longitude">,
  startMs: number,
  endMs: number
): Promise<boolean> {
  const hours = await fetchLiveRadiation(location.latitude, location.longitude, { pastDays: 10, forecastDays: 1 });
  const flags = snowGateFlags(
    hours.map(hour => hour.snowfallCm ?? Number.NaN),
    hours.map(hour => hour.snowDepthMetres ?? Number.NaN)
  );
  return hours.some((hour, index) => hour.hourStartMs >= startMs && hour.hourStartMs < endMs && flags[index] === 1);
}

/** The valid settled days of the week before `beforeMs`, oldest first */
export async function recentValidDays(
  influxClient: Influx.InfluxDB,
  beforeMs: number
): Promise<DailyForecastAccuracy[]> {
  const rows = await influxClient.query<{ time: Date; actual_kwh: number; day_ahead_kwh: number; valid: boolean }>(
    `SELECT actual_kwh, day_ahead_kwh, valid FROM solar_forecast_daily WHERE time >= ${beforeMs - 10 * 86_400_000}ms AND time < ${beforeMs}ms`
  );
  return rows
    .filter(row => row.valid)
    .map(row => ({
      date: localDateStr(row.time.getTime()),
      actual_kwh: row.actual_kwh,
      forecast_kwh: row.day_ahead_kwh,
    }))
    .slice(-6);
}

/** The week-alert state of the latest settled day before dayStartMs (within 10 days), if any */
export async function previousWeekEpisode(
  influxClient: Influx.InfluxDB,
  dayStartMs: number
): Promise<{ alarm: boolean; episode_open: boolean; clear_days: number; pushed: boolean } | undefined> {
  const rows = await influxClient.query<{
    week_alarm: boolean | null;
    week_episode_open: boolean | null;
    week_clear_days: number | null;
    week_episode_pushed: boolean | null;
  }>(
    `SELECT week_alarm, week_episode_open, week_clear_days, week_episode_pushed FROM solar_forecast_daily ` +
      `WHERE time >= ${dayStartMs - 10 * 86_400_000}ms AND time < ${dayStartMs}ms ORDER BY time DESC LIMIT 1`
  );
  const [latest] = rows;
  if (!latest) return undefined;
  return {
    alarm: latest.week_alarm === true,
    episode_open: latest.week_episode_open === true,
    clear_days: latest.week_clear_days ?? 0,
    pushed: latest.week_episode_pushed === true,
  };
}

export async function dailyPointExists(
  influxClient: Influx.InfluxDB,
  startMs: number,
  endMs: number
): Promise<boolean> {
  const rows = await influxClient.query<{ actual_kwh: number }>(
    `SELECT last(actual_kwh) AS actual_kwh FROM solar_forecast_daily WHERE time >= ${startMs}ms AND time < ${endMs}ms`
  );
  return rows.length > 0;
}
