import type Influx from "influx";
import { type Accessor, onCleanup, untrack } from "solid-js";
import type { Config } from "../config/config.types.ts";
import { errorLog, logLog, warnLog } from "../utilities/logging.ts";
import { msUntilNextLocalTime } from "../utilities/msUntilNextLocalTime.ts";
import { refitSolarModel } from "./solarRefit.ts";
import { loadSolarModelState } from "./solarModelStore.ts";
import { fittedGeometryMatches } from "./solarModelGeometry.ts";

/**
 * Keeps the fitted PV state fresh: an initial fit shortly after boot when there is none (fresh
 * install, deleted state file, edited geometry), then a daily check that refits once
 * solar_model.refit_every_days has passed. Run at 03:40 local — dark, and nowhere near the 13:10
 * plan. A failed fetch or query only warns and retries; it pages once the model is overdue by
 * a week (or, with no fit at all, once fitting has failed for a day).
 */
export function startSolarModelRefits(ctx: {
  config: Accessor<Config>;
  influxClient: Accessor<Influx.InfluxDB | undefined>;
}) {
  const tracker: RefitTracker = { inFlight: false, failingSinceMs: undefined };
  let dailyTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleDaily = () => {
    dailyTimer = setTimeout(async () => {
      await maybeRefit(ctx, tracker);
      scheduleDaily();
    }, msUntilNextLocalTime(DAILY_CHECK_LOCAL_TIME));
  };
  const startupTimer = setTimeout(() => void maybeRefit(ctx, tracker), STARTUP_DELAY_MS);
  // With no fit at all the forecast runs on the default horizon mask — retry sooner than daily
  const unfittedRetry = setInterval(async () => {
    const state = await loadSolarModelState();
    if (!state || !fittedGeometryMatches(state, untrack(ctx.config).automatic_trading.solar_model)) {
      await maybeRefit(ctx, tracker);
    }
  }, UNFITTED_RETRY_MS);
  scheduleDaily();
  onCleanup(() => {
    clearTimeout(startupTimer);
    clearTimeout(dailyTimer);
    clearInterval(unfittedRetry);
  });
}

type RefitTracker = { inFlight: boolean; failingSinceMs: number | undefined };

const DAILY_CHECK_LOCAL_TIME = "03:40";
/** Let the controller settle (mqtt, Influx, SOC) before the heavy history read */
const STARTUP_DELAY_MS = 2 * 60_000;
const UNFITTED_RETRY_MS = 3 * 3600_000;
const OVERDUE_GRACE_DAYS = 7;

async function maybeRefit(
  ctx: { config: Accessor<Config>; influxClient: Accessor<Influx.InfluxDB | undefined> },
  tracker: RefitTracker
) {
  if (tracker.inFlight) return;
  const config = untrack(ctx.config);
  const solarModel = config.automatic_trading.solar_model;
  const state = await loadSolarModelState();
  const fitted = state && fittedGeometryMatches(state, solarModel);
  const lastAttemptMs = state?.last_attempt ? Date.parse(state.last_attempt.at) : 0;
  const nowMs = Date.now();
  // A rejected candidate is retried on the normal cadence, not daily — the data won't change by tomorrow
  const due =
    !fitted || nowMs - Math.max(Date.parse(state.fitted_at), lastAttemptMs) >= solarModel.refit_every_days * 86_400_000;
  if (!due) return;
  const influxClient = ctx.influxClient();
  if (!influxClient) {
    warnLog("Solar model: refit due but InfluxDB is not configured");
    return;
  }
  tracker.inFlight = true;
  try {
    logLog(
      fitted ? "Solar model: monthly refit" : "Solar model: no fitted state for this geometry — fitting from history"
    );
    await refitSolarModel({ config, influxClient, nowMs, persist: true });
    tracker.failingSinceMs = undefined;
  } catch (error) {
    tracker.failingSinceMs ??= nowMs;
    const overdueMs = fitted
      ? nowMs - Date.parse(state.fitted_at) - (solarModel.refit_every_days + OVERDUE_GRACE_DAYS) * 86_400_000
      : nowMs - tracker.failingSinceMs - 86_400_000;
    if (overdueMs >= 0) {
      errorLog(
        fitted
          ? `Solar model: refit failing and the fit is now ${Math.round((nowMs - Date.parse(state.fitted_at)) / 86_400_000)} days old`
          : "Solar model: no fit for a day — forecasting on the default horizon mask",
        error
      );
    } else {
      warnLog("Solar model: refit failed, will retry", error);
    }
  } finally {
    tracker.inFlight = false;
  }
}
