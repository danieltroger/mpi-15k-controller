/**
 * Which solar forecast the terminal value's solar refill (terminalValueSolar.ts) may look past the horizon with:
 * planner-input assembly (plannerInputs.ts) sets PlannerInput.solarForecastEndMs from it.
 */
import { logLog, warnLog } from "../utilities/logging.ts";
import type { SolarForecast } from "./solarForecast.ts";
import type { PlannerKnobs } from "./planner.types.ts";
import type { TraderCtx } from "./traderContext.ts";

/**
 * A solar forecast older than this isn't looked past the horizon with: a guard, not a tunable. The forecast is
 * re-fetched hourly, so it is only this old when open-meteo has failed for hours and fetchSolarForecast hands out
 * its stale cache. That still prices the horizon, but a refill credited on it would rest on a forecast half a day
 * of model runs behind.
 */
export const SOLAR_REFILL_MAX_FORECAST_AGE_MS = 12 * 3600_000;

/**
 * Main: where the solar forecast ends, or undefined while it is too old for the solar refill (the end-of-plan
 * energy is then valued as without the refill). Logs when that starts while the refill is on, and once when the
 * forecast is fresh again, not on every plan: planner input is built on every guard and opportunistic tick.
 */
export function solarForecastEndForRefill(
  flags: Pick<TraderCtx["flags"], "solarForecastTooOldForRefill">,
  solar: Pick<SolarForecast, "fetchedAtMs" | "rangeEndMs">,
  knobs: Pick<
    PlannerKnobs,
    "terminal_value_mode" | "terminal_value_solar_scale" | "terminal_value_solar_lookahead_hours"
  >,
  nowMs: number
): number | undefined {
  const ageMs = nowMs - solar.fetchedAtMs;
  const tooOld = ageMs > SOLAR_REFILL_MAX_FORECAST_AGE_MS;
  const refillOn =
    knobs.terminal_value_mode !== "off" &&
    knobs.terminal_value_solar_scale > 0 &&
    knobs.terminal_value_solar_lookahead_hours > 0;
  if (tooOld !== flags.solarForecastTooOldForRefill && (refillOn || !tooOld)) {
    flags.solarForecastTooOldForRefill = tooOld;
    if (tooOld) {
      warnLog(
        `Auto trader: the solar forecast is ${(ageMs / 3600_000).toFixed(1)} h old (fetched ${new Date(solar.fetchedAtMs).toISOString()}, max ${SOLAR_REFILL_MAX_FORECAST_AGE_MS / 3600_000} h) — end-of-plan energy is valued without the solar refill until a fresh one arrives`
      );
    } else {
      logLog("Auto trader: solar forecast fresh again — the end-of-plan energy value counts the solar refill again");
    }
  }
  return tooOld ? undefined : solar.rangeEndMs;
}
