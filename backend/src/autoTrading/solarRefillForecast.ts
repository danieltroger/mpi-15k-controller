/**
 * Which solar forecast the terminal value's solar refill (terminalValueSolar.ts) may look past the horizon with:
 * planner-input assembly (plannerInputs.ts) sets PlannerInput.solarForecastEndMs from it.
 */
import { logLog, warnLog } from "../utilities/logging.ts";
import { terminalValueInSeason } from "./terminalValue.ts";
import type { SolarForecast } from "./solarForecast.ts";
import type { PlannerKnobs } from "./planner.types.ts";
import type { TraderCtx } from "./traderContext.ts";

const HOUR_MS = 3600_000;

/**
 * Main: where the solar forecast ends, or undefined while it is older than terminal_value_solar_forecast_max_age_hours
 * (a stale cache fetchSolarForecast hands out through an open-meteo outage; the end-of-plan energy is then valued as
 * without the refill). Logs when that starts while the refill applies (the terminal value on and in season, the
 * refill's knobs above 0), and once when the forecast is fresh again if it still does; not on every plan: planner
 * input is built on every guard and opportunistic tick.
 */
export function solarForecastEndForRefill(
  flags: Pick<TraderCtx["flags"], "solarForecastTooOldForRefill">,
  solar: Pick<SolarForecast, "fetchedAtMs" | "rangeEndMs">,
  knobs: Pick<
    PlannerKnobs,
    | "terminal_value_mode"
    | "terminal_value_months"
    | "terminal_value_solar_scale"
    | "terminal_value_solar_lookahead_hours"
    | "terminal_value_solar_forecast_max_age_hours"
  >,
  nowMs: number
): number | undefined {
  const ageMs = nowMs - solar.fetchedAtMs;
  const maxAgeHours = knobs.terminal_value_solar_forecast_max_age_hours;
  const tooOld = ageMs > maxAgeHours * HOUR_MS;
  const refillApplies =
    terminalValueInSeason(knobs, nowMs) &&
    knobs.terminal_value_solar_scale > 0 &&
    knobs.terminal_value_solar_lookahead_hours > 0;
  if (tooOld && refillApplies && !flags.solarForecastTooOldForRefill) {
    flags.solarForecastTooOldForRefill = true;
    warnLog(
      `Auto trader: the solar forecast is ${(ageMs / HOUR_MS).toFixed(1)} h old (fetched ${new Date(solar.fetchedAtMs).toISOString()}, max ${maxAgeHours} h) — end-of-plan energy is valued without the solar refill until a fresh one arrives`
    );
  } else if (!tooOld && flags.solarForecastTooOldForRefill) {
    flags.solarForecastTooOldForRefill = false;
    if (refillApplies) {
      logLog("Auto trader: solar forecast fresh again — the end-of-plan energy value counts the solar refill again");
    }
  }
  return tooOld ? undefined : solar.rangeEndMs;
}
