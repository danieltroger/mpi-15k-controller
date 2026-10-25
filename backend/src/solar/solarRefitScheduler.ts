import { type Accessor, onCleanup, untrack } from "solid-js";
import type { Config, SolarModelConfig } from "../config/config.types.ts";
import { warnLog } from "../utilities/logging.ts";
import { refitSolarModel } from "./solarRefit.ts";
import { loadSolarModelState } from "./solarModelStore.ts";
import { fittedGeometryMatches } from "./solarModelGeometry.ts";
import type { SolarModelState } from "./solarModel.types.ts";

/**
 * Keeps the fitted PV state fresh with one hourly check: an initial fit soon after boot when there
 * is none for the configured geometry (fresh install, deleted state file, edited tilt/azimuth),
 * then a refit once solar_model.refit_every_days has passed — in the 03:00–05:59 local window,
 * dark and nowhere near the 13:10 plan. Failures back off (solarRefit.ts records next_attempt_at)
 * and page at most once per episode. The heavy work runs in a child process; this tick only reads
 * the small state file.
 */
export function startSolarModelRefits(ctx: { config: Accessor<Config> }) {
  const check = () =>
    void maybeRefit(untrack(ctx.config)).catch(error => warnLog("Solar model: refit check failed", error));
  const startupTimer = setTimeout(check, STARTUP_DELAY_MS);
  const hourlyCheck = setInterval(check, CHECK_INTERVAL_MS);
  onCleanup(() => {
    clearTimeout(startupTimer);
    clearInterval(hourlyCheck);
  });
}

/** Pure: is a refit due now? Exported for the selftest. */
export function isRefitDue(state: SolarModelState | undefined, solarModel: SolarModelConfig, nowMs: number): boolean {
  const status = state?.refit;
  if (status?.next_attempt_at && nowMs < Date.parse(status.next_attempt_at)) return false;
  const fit = state?.fit;
  if (!fit || !fittedGeometryMatches(fit, solarModel)) return true;
  const lastAttemptMs = Math.max(
    Date.parse(fit.fitted_at),
    status?.last_attempt_at ? Date.parse(status.last_attempt_at) : 0
  );
  if (nowMs - lastAttemptMs < solarModel.refit_every_days * 86_400_000) return false;
  const localHour = Number(
    new Date(nowMs).toLocaleString("sv-SE", { timeZone: "Europe/Stockholm", hour: "2-digit", hourCycle: "h23" })
  );
  return localHour >= NIGHT_WINDOW_START_HOUR && localHour < NIGHT_WINDOW_END_HOUR;
}

/** Let the controller settle (mqtt, Influx, SOC) before the heavy history read */
const STARTUP_DELAY_MS = 2 * 60_000;
const CHECK_INTERVAL_MS = 3600_000;
const NIGHT_WINDOW_START_HOUR = 3;
const NIGHT_WINDOW_END_HOUR = 6;

async function maybeRefit(config: Config) {
  const nowMs = Date.now();
  if (!isRefitDue(await loadSolarModelState(), config.automatic_trading.solar_model, nowMs)) return;
  // Failures are logged, recorded and backed off inside; nothing to add here
  await refitSolarModel({ config, nowMs, persist: true });
}
