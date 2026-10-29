/**
 * Assembles the planner's input from the live trader: prices, the solar/elpatron/consumption forecasts,
 * the inverter's measured feed-in, the user's (immutable) schedule entries and the vetoes. Also turns
 * owned schedule entries into the fixed windows a re-plan or projection treats as given.
 */

import { untrack } from "solid-js";
import type { Config } from "../config/config.types.ts";
import { logLog } from "../utilities/logging.ts";
import { inverterIdleWatts, packCapacityWh } from "../battery/ahLedgerDerivedValues.ts";
import type { FetchedPrices } from "./priceService.ts";
import { fetchSolarForecast } from "./solarForecast.ts";
import { fetchConsumptionForecast } from "./consumptionForecast.ts";
import { fetchElpatronForecast } from "./elpatronForecast.ts";
import { plannerKnobsFromConfig } from "./plannerKnobs.ts";
import { sellScheduleWindows } from "./sellScheduleWindows.ts";
import { freshMeasuredFeedInW, MEASURED_FEED_IN_MAX_AGE_MS } from "./measuredFeedIn.ts";
import { entriesEqual } from "./scheduleOwnership.ts";
import type { FixedWindow, PlannerInput } from "./planner.types.ts";
import type { MqttValue } from "../sharedTypes.ts";
import type { TraderCtx } from "./traderContext.ts";

/** The parts of the trader context planner-input assembly reads (and flags.measuredFeedInStale, which it writes) */
export type PlannerInputContext = Pick<TraderCtx, "gridPowerReading" | "influxClient" | "state" | "flags">;

export async function buildPlannerInput(
  ctx: PlannerInputContext,
  cfg: Config,
  prices: FetchedPrices,
  soc: number
): Promise<PlannerInput> {
  const tradingConfig = cfg.automatic_trading;
  const nowMs = Date.now();
  // Sampled together with nowMs: a sell window running now starts the simulation where the inverter
  // measurably is, not where replaying the schedule puts it (runningFeedAtNow)
  const gridPowerReading = untrack(ctx.gridPowerReading);
  const measuredFeedInW = freshMeasuredFeedInW(gridPowerReading, nowMs);
  logMeasuredFeedInFreshnessChange(ctx.flags, measuredFeedInW, gridPowerReading);
  const solar = await fetchSolarForecast(tradingConfig, ctx.influxClient());
  // The water heater element is our own scheduled load, not a forecastable one: model it forward
  // and strip its share out of the learned baseline so it isn't counted twice
  const elpatron = await fetchElpatronForecast({
    elpatronConfig: cfg.elpatron_switching,
    influxClient: ctx.influxClient(),
    solarWattsAt: solar.wattsAt,
    nowMs,
  });
  const consumption = await fetchConsumptionForecast(
    ctx.influxClient(),
    tradingConfig.fallback_house_load_watts,
    cfg.elpatron_switching
  );
  const { sells, buys } = userWindows(ctx, cfg);
  return {
    nowMs,
    prices: prices.slots,
    solarWattsAt: solar.wattsAt,
    solarAverageWattsBetween: solar.averageWattsBetween,
    houseLoadWattsAt: ms => consumption.wattsAt(ms) + elpatron.wattsAt(ms),
    // Idle draw and usable capacity now come from the Ah ledger's online-tracked drain/capacity (the Wh
    // fitter's persisted capacity/parasitic state is gone): inverterIdleWatts = drain_a × v_discharge, capacityWh = capacity_ah × v_discharge.
    parasiticWatts: inverterIdleWatts(cfg),
    socPercent: soc,
    capacityWh: packCapacityWh(cfg),
    constraintTailHours: tradingConfig.constraint_tail_hours,
    fixedSells: sells,
    fixedBuys: buys,
    // Everything the runtime is executing, ours included: a window running at nowMs has already
    // ramped up, and the simulation must not credit that ramp a second time
    runningSellSchedule: sellScheduleWindows(cfg.scheduled_power_selling.schedule),
    measuredFeedInW,
    sellVetoWindows: ctx.state.vetoes
      .filter(veto => veto.kind === "sell")
      .map(veto => ({ startMs: +new Date(veto.start), endMs: +new Date(veto.end) })),
    buyVetoWindows: ctx.state.vetoes
      .filter(veto => veto.kind === "buy")
      .map(veto => ({ startMs: +new Date(veto.start), endMs: +new Date(veto.end) })),
    knobs: plannerKnobsFromConfig(cfg),
  };
}

/**
 * Logs when the grid power reading goes stale (a running sell window's ramp is then replayed from the
 * schedule) and once when it is fresh again. Only the transitions: buildPlannerInput runs on every guard
 * and opportunistic tick, so a telemetry stall would otherwise repeat the same line on each of them.
 * The flag starts out fresh, so a reading that is already stale at the first plan after boot is logged.
 */
function logMeasuredFeedInFreshnessChange(
  flags: TraderCtx["flags"],
  measuredFeedInW: number | undefined,
  gridPowerReading: MqttValue | undefined
) {
  const readingIsStale = measuredFeedInW === undefined;
  if (readingIsStale === flags.measuredFeedInStale) return;
  flags.measuredFeedInStale = readingIsStale;
  if (readingIsStale) {
    logLog(
      `Auto trader: no grid power reading within ${MEASURED_FEED_IN_MAX_AGE_MS / 1000} s (last ${gridPowerReading ? new Date(gridPowerReading.time).toISOString() : "never"}) — a running sell window's ramp is replayed from the schedule until a fresh reading arrives`
    );
  } else {
    logLog(
      `Auto trader: grid power reading fresh again (feed-in ${measuredFeedInW} W) — a running sell window starts from the measured feed-in`
    );
  }
}

/** Schedule entries in the config that are NOT ours — the planner must treat them as immutable. */
function userWindows(ctx: PlannerInputContext, cfg: Config): { sells: FixedWindow[]; buys: FixedWindow[] } {
  const sells: FixedWindow[] = [];
  const buys: FixedWindow[] = [];
  for (const [key, entry] of Object.entries(cfg.scheduled_power_selling.schedule)) {
    const owned = ctx.state.owned_entries.selling[key];
    if (owned && entriesEqual(entry, owned, "power_watts")) continue;
    const startMs = +new Date(key);
    const endMs = +new Date(entry.end_time);
    if (isFinite(startMs) && isFinite(endMs)) sells.push({ startMs, endMs, watts: Number(entry.power_watts) || 0 });
  }
  for (const [key, entry] of Object.entries(cfg.scheduled_power_buying.schedule)) {
    const owned = ctx.state.owned_entries.buying[key];
    if (owned && entriesEqual(entry, owned, "charging_power")) continue;
    const startMs = +new Date(key);
    const endMs = +new Date(entry.end_time);
    if (isFinite(startMs) && isFinite(endMs)) buys.push({ startMs, endMs, watts: Number(entry.charging_power) || 0 });
  }
  return { sells, buys };
}

export function ownedEntriesAsWindows(
  entries: Record<string, { end_time: string }>,
  powerKey: "power_watts" | "charging_power"
): FixedWindow[] {
  return Object.entries(entries).map(([key, entry]) => ({
    startMs: +new Date(key),
    endMs: +new Date(entry.end_time),
    watts: Number((entry as Record<string, unknown>)[powerKey]),
  }));
}
