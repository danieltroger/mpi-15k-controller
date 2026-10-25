import type Influx from "influx";
import { type Accessor, onCleanup, untrack } from "solid-js";
import type { Config } from "../config/config.types.ts";
import type { AlertManager } from "../alerting/alertManager.ts";
import { fetchSolarForecast } from "../autoTrading/solarForecast.ts";
import { localDateStr } from "../autoTrading/tradingPerformance.ts";
import { logLog, warnLog } from "../utilities/logging.ts";
import { msUntilNextLocalTime } from "../utilities/msUntilNextLocalTime.ts";
import { sunPosition } from "../utilities/sunPosition.ts";
import { queryHourlyStringWatts, queryPvHistory } from "./pvHistory.ts";
import { isStalledBin } from "./pvStall.ts";
import { judgeForecastWeek, type DailyForecastAccuracy } from "./solarForecastAccuracyRule.ts";

/**
 * Forecast-vs-actual bookkeeping in InfluxDB, independent of whether automatic trading runs:
 *  - `solar_forecast` (tag lead = day_ahead | short): the per-string hourly forecast — day-ahead
 *    as of 13:20 local (the plan's forecast), short-lead as of a few minutes into each hour
 *  - `solar_forecast_daily`: per local day, actual vs both forecasts, per string and total
 * and the rolling-week P2 (alerting.solar_forecast_accuracy_p2) when the day-ahead forecast has
 * been badly off for a week, two daily evaluations in a row. Days with an inverter outage (the
 * stuck-inverter alert covers those) or under 90 % telemetry are left out of the week.
 */
export function startSolarForecastAccuracy(ctx: AccuracyContext) {
  const timers: Partial<Record<"shortLead" | "dayAhead" | "settle" | "startup", ReturnType<typeof setTimeout>>> = {};
  const scheduleShortLead = () =>
    (timers.shortLead = setTimeout(
      () => void recordForecast(ctx, "short").finally(scheduleShortLead),
      msUntilNextHourPlus(SHORT_LEAD_MINUTE)
    ));
  const scheduleDayAhead = () =>
    (timers.dayAhead = setTimeout(
      () => void recordForecast(ctx, "day_ahead").finally(scheduleDayAhead),
      msUntilNextLocalTime(DAY_AHEAD_LOCAL_TIME)
    ));
  const scheduleSettle = () =>
    (timers.settle = setTimeout(
      () => void settleDay(ctx, localDateStr(Date.now() - 86_400_000), { alert: true }).finally(scheduleSettle),
      msUntilNextLocalTime(SETTLE_LOCAL_TIME)
    ));
  scheduleShortLead();
  scheduleDayAhead();
  scheduleSettle();
  // Catch up a settlement missed across a restart, without alerting (the scheduled run owns alerts)
  timers.startup = setTimeout(
    () => void settleDay(ctx, localDateStr(Date.now() - 86_400_000), { alert: false }),
    STARTUP_DELAY_MS
  );
  onCleanup(() => Object.values(timers).forEach(timer => clearTimeout(timer)));
}

type AccuracyContext = {
  config: Accessor<Config>;
  influxClient: Accessor<Influx.InfluxDB | undefined>;
  raise: AlertManager["raise"];
};

const SHORT_LEAD_MINUTE = 5;
/** Ten minutes after the 13:10 plan, so the cached forecast is the one the plan used */
const DAY_AHEAD_LOCAL_TIME = "13:20";
const SETTLE_LOCAL_TIME = "03:30";
const STARTUP_DELAY_MS = 5 * 60_000;
const MIN_TELEMETRY_SHARE = 0.9;
/** 30 min of stalled-PV bins in a day marks it as an outage day */
const MAX_STALLED_BINS = 3;

/** Writes the per-string forecast for the current hour ("short") or tomorrow's local day ("day_ahead"). */
async function recordForecast(ctx: AccuracyContext, lead: "short" | "day_ahead") {
  const influxClient = ctx.influxClient();
  if (!influxClient) return;
  try {
    const forecast = await fetchSolarForecast(untrack(ctx.config).automatic_trading, influxClient);
    const nowMs = Date.now();
    const currentHourMs = Math.floor(nowMs / 3600_000) * 3600_000;
    const tomorrow = localDateStr(nowMs + 86_400_000);
    const hours = forecast.hours.filter(hour =>
      lead === "short" ? hour.hourStartMs === currentHourMs : localDateStr(hour.hourStartMs) === tomorrow
    );
    if (!hours.length) return;
    await influxClient.writePoints(
      hours.map(hour => ({
        measurement: "solar_forecast",
        tags: { lead, model: forecast.model },
        fields: {
          string1_w: Math.round(hour.string1Watts),
          string2_w: Math.round(hour.string2Watts),
          total_w: Math.round(hour.string1Watts + hour.string2Watts),
        },
        timestamp: new Date(hour.hourStartMs),
      }))
    );
  } catch (error) {
    warnLog(`Solar forecast accuracy: recording the ${lead} forecast failed`, error);
  }
}

async function settleDay(ctx: AccuracyContext, date: string, options: { alert: boolean }) {
  const influxClient = ctx.influxClient();
  if (!influxClient) return;
  const config = untrack(ctx.config);
  try {
    const { startMs, endMs } = localDayBounds(date);
    if (!options.alert && (await dailyPointExists(influxClient, startMs, endMs))) return;
    const solarModel = config.automatic_trading.solar_model;
    const actual = await queryHourlyStringWatts(
      influxClient,
      startMs,
      endMs,
      solarModel.rewired_at ? Date.parse(solarModel.rewired_at) : Number.NaN
    );
    const dayAhead = await queryForecastHours(influxClient, "day_ahead", startMs, endMs);
    const shortLead = await queryForecastHours(influxClient, "short", startMs, endMs);
    const stalledBins = await countStalledBins(influxClient, startMs, endMs, config.automatic_trading);
    const hoursInDay = (endMs - startMs) / 3600_000;
    const valid =
      actual.size >= MIN_TELEMETRY_SHARE * hoursInDay && stalledBins < MAX_STALLED_BINS && dayAhead.size > 0;
    const sumKwh = (byHour: Map<number, { string1: number; string2: number }>, pick: "string1" | "string2") =>
      [...byHour.values()].reduce((sum, hour) => sum + (Number.isFinite(hour[pick]) ? hour[pick] : 0), 0) / 1000;
    const fields: Record<string, number | boolean> = {
      actual_kwh: round1(sumKwh(actual, "string1") + sumKwh(actual, "string2")),
      string1_actual_kwh: round1(sumKwh(actual, "string1")),
      string2_actual_kwh: round1(sumKwh(actual, "string2")),
      day_ahead_kwh: round1(sumKwh(dayAhead, "string1") + sumKwh(dayAhead, "string2")),
      string1_day_ahead_kwh: round1(sumKwh(dayAhead, "string1")),
      string2_day_ahead_kwh: round1(sumKwh(dayAhead, "string2")),
      short_lead_kwh: round1(sumKwh(shortLead, "string1") + sumKwh(shortLead, "string2")),
      day_ahead_hourly_mae_w: Math.round(hourlyMeanAbsoluteError(actual, dayAhead)),
      stalled_bins: stalledBins,
      valid,
    };
    const verdict = judgeForecastWeek(
      [
        ...(await recentValidDays(influxClient, startMs)),
        ...(valid ? [{ date, actual_kwh: Number(fields.actual_kwh), forecast_kwh: Number(fields.day_ahead_kwh) }] : []),
      ],
      {
        min_ratio: config.alerting.solar_forecast_week_min_ratio,
        max_ratio: config.alerting.solar_forecast_week_max_ratio,
        max_error_share: config.alerting.solar_forecast_week_max_error_share,
      }
    );
    if (verdict) {
      fields.week_ratio = Math.round(verdict.ratio * 1000) / 1000;
      fields.week_error_share = Math.round(verdict.error_share * 1000) / 1000;
      fields.week_alarm = verdict.alarm;
    }
    const previousAlarm = await previousDayAlarm(influxClient, startMs);
    // Local noon, so the point lands unambiguously on its day in Grafana
    await influxClient.writePoints([
      { measurement: "solar_forecast_daily", fields, timestamp: new Date(startMs + 12 * 3600_000) },
    ]);
    logLog(
      `Solar forecast accuracy ${date}: actual ${fields.actual_kwh} kWh vs day-ahead ${fields.day_ahead_kwh} (short-lead ${fields.short_lead_kwh})` +
        (verdict
          ? `, week ×${verdict.ratio.toFixed(2)} / error share ${verdict.error_share.toFixed(2)}${verdict.alarm ? " ALARM" : ""}`
          : "") +
        (valid ? "" : " — day excluded (outage, data gap or no day-ahead forecast)")
    );
    if (options.alert && verdict?.alarm && previousAlarm && config.alerting.solar_forecast_accuracy_p2) {
      void ctx.raise({
        key: "solar-forecast-accuracy",
        severity: "P2",
        title: "PV forecast off for a week",
        message:
          `Over the last ${verdict.days} days the panels made ${verdict.actual_kwh.toFixed(0)} kWh against a day-ahead forecast of ` +
          `${verdict.forecast_kwh.toFixed(0)} kWh (×${verdict.ratio.toFixed(2)}, daily misses ${Math.round(verdict.error_share * 100)} % of the forecast). ` +
          `Snow on the panels, a string down, new shade, or the model needs a look (backend/solar_model_state.json).`,
      });
    }
  } catch (error) {
    warnLog(`Solar forecast accuracy: settling ${date} failed (retried at the next settlement)`, error);
  }
}

async function queryForecastHours(
  influxClient: Influx.InfluxDB,
  lead: "short" | "day_ahead",
  startMs: number,
  endMs: number
): Promise<Map<number, { string1: number; string2: number }>> {
  const rows = await influxClient.query<{ time: Date; string1_w: number; string2_w: number }>(
    `SELECT last(string1_w) AS string1_w, last(string2_w) AS string2_w FROM solar_forecast WHERE "lead" = '${lead}' AND time >= ${startMs}ms AND time < ${endMs}ms GROUP BY time(1h) fill(none)`
  );
  return new Map(rows.map(row => [row.time.getTime(), { string1: row.string1_w, string2: row.string2_w }]));
}

async function countStalledBins(
  influxClient: Influx.InfluxDB,
  startMs: number,
  endMs: number,
  location: { latitude: number; longitude: number }
): Promise<number> {
  let stalled = 0;
  for (const hour of await queryPvHistory(influxClient, startMs, endMs)) {
    hour.mppt1Watts.forEach((mppt1Watts, bin) => {
      const binMidMs = hour.hourStartMs + bin * 600_000 + 300_000;
      const sunElevationDegrees = sunPosition(binMidMs, location.latitude, location.longitude).apparentElevationDegrees;
      if (
        isStalledBin({
          mppt1Watts,
          mppt2Watts: hour.mppt2Watts[bin],
          mppt1Volts: hour.mppt1Volts[bin],
          mppt2Volts: hour.mppt2Volts[bin],
          sunElevationDegrees,
        })
      ) {
        stalled += 1;
      }
    });
  }
  return stalled;
}

/** The valid settled days of the week before `beforeMs`, oldest first */
async function recentValidDays(influxClient: Influx.InfluxDB, beforeMs: number): Promise<DailyForecastAccuracy[]> {
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

async function previousDayAlarm(influxClient: Influx.InfluxDB, dayStartMs: number): Promise<boolean> {
  const rows = await influxClient.query<{ week_alarm: boolean | null }>(
    `SELECT last(week_alarm) AS week_alarm FROM solar_forecast_daily WHERE time >= ${dayStartMs - 36 * 3600_000}ms AND time < ${dayStartMs}ms`
  );
  return rows[0]?.week_alarm === true;
}

async function dailyPointExists(influxClient: Influx.InfluxDB, startMs: number, endMs: number): Promise<boolean> {
  const rows = await influxClient.query<{ actual_kwh: number }>(
    `SELECT last(actual_kwh) AS actual_kwh FROM solar_forecast_daily WHERE time >= ${startMs}ms AND time < ${endMs}ms`
  );
  return rows.length > 0;
}

function hourlyMeanAbsoluteError(
  actual: Map<number, { string1: number; string2: number }>,
  forecast: Map<number, { string1: number; string2: number }>
): number {
  let errorSum = 0;
  let hours = 0;
  for (const [hourStartMs, predicted] of forecast) {
    const observed = actual.get(hourStartMs);
    if (!observed) continue;
    errorSum += Math.abs(observed.string1 + (observed.string2 || 0) - predicted.string1 - predicted.string2);
    hours += 1;
  }
  return hours ? errorSum / hours : 0;
}

/** [start, end) of a Europe/Stockholm calendar day in UTC ms (whole-hour offsets, so hour steps suffice) */
export function localDayBounds(date: string): { startMs: number; endMs: number } {
  let startMs = Date.parse(`${date}T00:00:00Z`) - 3 * 3600_000;
  while (localDateStr(startMs) !== date) startMs += 3600_000;
  let endMs = startMs + 20 * 3600_000;
  while (localDateStr(endMs) === date) endMs += 3600_000;
  return { startMs, endMs };
}

function msUntilNextHourPlus(minute: number): number {
  const nowMs = Date.now();
  const target = Math.floor(nowMs / 3600_000) * 3600_000 + minute * 60_000;
  return target > nowMs ? target - nowMs : target + 3600_000 - nowMs;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
