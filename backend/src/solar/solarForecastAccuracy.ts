import type Influx from "influx";
import { type Accessor, onCleanup, untrack } from "solid-js";
import type { Config } from "../config/config.types.ts";
import type { AlertManager } from "../alerting/alertManager.ts";
import { fetchSolarForecast } from "../autoTrading/solarForecast.ts";
import { localDateStr } from "../autoTrading/tradingPerformance.ts";
import { logLog, warnLog } from "../utilities/logging.ts";
import { msUntilNextLocalTime } from "../utilities/msUntilNextLocalTime.ts";
import { influxClientQuery } from "./influxQuery.ts";
import { queryHourlyStringWatts } from "./pvHistory.ts";
import { advanceWeekAlertEpisode, judgeForecastWeek } from "./solarForecastAccuracyRule.ts";
import {
  countStalledBins,
  dailyPointExists,
  previousWeekEpisode,
  queryForecastHours,
  recentValidDays,
  snowGatedDuring,
  sumKwh,
  type StringWattsByHour,
} from "./solarForecastAccuracyQueries.ts";

/**
 * Forecast-vs-actual bookkeeping in InfluxDB, independent of whether automatic trading runs:
 *  - `solar_forecast` (tag lead = day_ahead | short): the per-string hourly forecast — day-ahead
 *    as of 13:20 local (the plan's forecast, with each string's snow gate), short-lead from a
 *    forecast at most 10 min old, a few minutes into each hour
 *  - `solar_forecast_daily`: per local day, actual vs both forecasts, per string and total
 * and the rolling-week P2 (alerting.solar_forecast_accuracy_p2): once per episode, when the
 * day-ahead forecast has been badly off for a week on two evaluations in a row, with a quiet P3
 * when it clears. Days with an inverter outage (the stuck-inverter alert covers those), snow on
 * the panels (the snow nowcast's job), under 90 % telemetry or no day-ahead forecast don't count.
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
      () => void settleRecentDays(ctx, { alert: true }).finally(scheduleSettle),
      msUntilNextLocalTime(SETTLE_LOCAL_TIME)
    ));
  scheduleShortLead();
  scheduleDayAhead();
  scheduleSettle();
  // Catch up settlements missed across a restart, without alerting (the scheduled run owns alerts)
  timers.startup = setTimeout(() => void settleRecentDays(ctx, { alert: false }), STARTUP_DELAY_MS);
  onCleanup(() => Object.values(timers).forEach(timer => clearTimeout(timer)));
}

type AccuracyContext = {
  config: Accessor<Config>;
  influxClient: Accessor<Influx.InfluxDB | undefined>;
  raise: AlertManager["raise"];
};

const SHORT_LEAD_MINUTE = 5;
/** The short-lead series means "as of minutes before", so it may not reuse the planner's hour-old cache */
const SHORT_LEAD_MAX_AGE_MS = 10 * 60_000;
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
    const forecast = await fetchSolarForecast(
      untrack(ctx.config).automatic_trading,
      influxClient,
      lead === "short" ? { maxAgeMs: SHORT_LEAD_MAX_AGE_MS } : {}
    );
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
          // The gate the nowcast applied at capture time, for reading the series back
          string1_snow_gate: forecast.nowcast.string1.gateOpen,
          string2_snow_gate: forecast.nowcast.string2.gateOpen,
        },
        timestamp: new Date(hour.hourStartMs),
      }))
    );
  } catch (error) {
    warnLog(`Solar forecast accuracy: recording the ${lead} forecast failed`, error);
  }
}

/**
 * Settles the last few local days, oldest first so the week-alert episode carries forward in
 * order: days with no point yet (a failed or missed settlement is retried here, up to 3 days
 * back), plus — on the scheduled run — yesterday, the only day that may alert.
 */
async function settleRecentDays(ctx: AccuracyContext, options: { alert: boolean }) {
  const influxClient = ctx.influxClient();
  if (!influxClient) return;
  for (let daysBack = BACKLOG_DAYS; daysBack >= 1; daysBack--) {
    const date = localDateStr(Date.now() - daysBack * 86_400_000);
    const isYesterday = daysBack === 1;
    const { startMs, endMs } = localDayBounds(date);
    const settled = await dailyPointExists(influxClient, startMs, endMs).catch((error: unknown) => {
      warnLog(`Solar forecast accuracy: can't tell whether ${date} is settled — settling it again`, error);
      return false;
    });
    if (settled && !(options.alert && isYesterday)) continue;
    await settleDay(ctx, date, { alert: options.alert && isYesterday });
  }
}

const BACKLOG_DAYS = 3;

async function settleDay(ctx: AccuracyContext, date: string, options: { alert: boolean }) {
  const influxClient = ctx.influxClient();
  if (!influxClient) return;
  const config = untrack(ctx.config);
  try {
    const { startMs, endMs } = localDayBounds(date);
    const solarModel = config.automatic_trading.solar_model;
    const actual: StringWattsByHour = await queryHourlyStringWatts(
      influxClientQuery(influxClient),
      startMs,
      endMs,
      solarModel.rewired_at ? Date.parse(solarModel.rewired_at) : Number.NaN,
      SETTLE_QUERY_TIMEOUT_MS
    );
    const dayAhead = await queryForecastHours(influxClient, "day_ahead", startMs, endMs);
    const shortLead = await queryForecastHours(influxClient, "short", startMs, endMs);
    const stalledBins = await countStalledBins(influxClient, startMs, endMs, config.automatic_trading);
    // Without the snow record the day can't be judged fairly: leave it out of the week rather than risk a false P2
    const snowGated = await snowGatedDuring(config.automatic_trading, startMs, endMs).catch((error: unknown) => {
      warnLog(`Solar forecast accuracy: snow record for ${date} unavailable — leaving the day out of the week`, error);
      return true;
    });
    const hoursInDay = (endMs - startMs) / 3600_000;
    const valid =
      actual.size >= MIN_TELEMETRY_SHARE * hoursInDay &&
      stalledBins < MAX_STALLED_BINS &&
      !snowGated &&
      dayAhead.size > 0;
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
      snow_gated: snowGated,
      valid,
    };
    const verdict = judgeForecastWeek(
      [
        ...(await recentValidDays(influxClient, startMs)),
        ...(valid ? [{ date, actual_kwh: Number(fields.actual_kwh), forecast_kwh: Number(fields.day_ahead_kwh) }] : []),
      ],
      config.alerting
    );
    // InfluxDB rejects NaN — an all-zero forecast week has no ratio, but its error share still judges it
    if (verdict && Number.isFinite(verdict.ratio)) fields.week_ratio = Math.round(verdict.ratio * 1000) / 1000;
    if (verdict) fields.week_error_share = Math.round(verdict.error_share * 1000) / 1000;
    const episode = advanceWeekAlertEpisode({
      alarm: verdict?.alarm ?? false,
      previous: await previousWeekEpisode(influxClient, startMs),
    });
    // Written on every day so the next settlement can carry the episode forward
    fields.week_alarm = verdict?.alarm ?? false;
    fields.week_episode_open = episode.episode_open;
    fields.week_clear_days = episode.clear_days;
    // Local noon, so the point lands unambiguously on its day in Grafana
    await influxClient.writePoints([
      { measurement: "solar_forecast_daily", fields, timestamp: new Date(startMs + 12 * 3600_000) },
    ]);
    logLog(
      `Solar forecast accuracy ${date}: actual ${fields.actual_kwh} kWh vs day-ahead ${fields.day_ahead_kwh} (short-lead ${fields.short_lead_kwh})` +
        (verdict
          ? `, week ×${verdict.ratio.toFixed(2)} / error share ${verdict.error_share.toFixed(2)}${verdict.alarm ? " ALARM" : ""}`
          : "") +
        (valid ? "" : " — day excluded (outage, snow, data gap or no day-ahead forecast)")
    );
    const decision = episode.decision;
    if (!options.alert || !config.alerting.solar_forecast_accuracy_p2 || decision === "none") return;
    if (decision === "push" && verdict) {
      void ctx.raise({
        key: "solar-forecast-accuracy",
        severity: "P2",
        title: "PV forecast off for a week",
        message:
          `Over the last ${verdict.days} valid days the panels made ${verdict.actual_kwh.toFixed(0)} kWh against a day-ahead forecast of ` +
          `${verdict.forecast_kwh.toFixed(0)} kWh (${Number.isFinite(verdict.ratio) ? `×${verdict.ratio.toFixed(2)}, ` : ""}daily misses ` +
          `${Math.round(verdict.error_share * 100)} % of the forecast; snow and outage days left out). ` +
          `A string down, new shade, or the model needs a look (backend/solar_model_state.json). One push per episode.`,
      });
    } else if (decision === "resolve") {
      void ctx.raise({
        key: "solar-forecast-accuracy:resolved",
        severity: "P3",
        title: "Resolved: PV forecast back on track",
        message: `The day-ahead PV forecast has been within bounds for several days again (${date}).`,
      });
    }
  } catch (error) {
    warnLog(
      `Solar forecast accuracy: settling ${date} failed (retried at the next settlement, up to 3 days back)`,
      error
    );
  }
}

const SETTLE_QUERY_TIMEOUT_MS = 30_000;

function hourlyMeanAbsoluteError(actual: StringWattsByHour, forecast: StringWattsByHour): number {
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
