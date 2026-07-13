import { type Accessor, createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js";
import { get_config_object } from "../config/config.ts";
import type { Config } from "../config/config.types.ts";
import { debugLog, errorLog, logLog, warnLog } from "../utilities/logging.ts";
import { wait } from "../vendor/depictUtilishared.ts";
import { msUntilNextLocalTime } from "../utilities/msUntilNextLocalTime.ts";
import { useInfluxClient } from "../utilities/InfluxClientProvider.ts";
import { useBatteryValuesProvider } from "../battery/BatteryValuesProvider.ts";
import { inverterIdleWatts, packCapacityWh } from "../battery/ahLedgerDerivedValues.ts";
import { fetchPrices, type FetchedPrices, getCachedPrices } from "./priceService.ts";
import { fetchSolarForecast } from "./solarForecast.ts";
import { fetchConsumptionForecast } from "./consumptionForecast.ts";
import { fetchElpatronForecast } from "./elpatronForecast.ts";
import {
  type AutoTraderState,
  type AutoTraderStatus,
  EMPTY_STATE,
  loadAutoTraderState,
  saveAutoTraderState,
} from "./autoTraderState.ts";
import { maybeRefitSolarModel } from "./solarCalibration.ts";
import { captureForecastLog, settleRecentDays } from "./tradingPerformance.ts";
import { generatePlan, projectWithFixedWindows } from "./planner.ts";
import type { FixedWindow, PlannedWindow, PlannerInput } from "./planner.types.ts";

/**
 * Everything the trader's module-level functions share. Passed explicitly instead of closing over
 * a giant outer scope so each function's inputs are visible at the call site (see CLAUDE.md).
 * `state` and `flags` are deliberately mutable.
 */
type TraderCtx = {
  config: Accessor<Config>;
  setConfig: Awaited<ReturnType<typeof get_config_object>>[1];
  /** Ah-ledger SOC clamped to [0,100] — the planner must never project from a nonsensical <0 / >100 start. */
  clampedSocAh: Accessor<number | undefined>;
  influxClient: ReturnType<typeof useInfluxClient>;
  enabled: Accessor<boolean>;
  nextDailyRunAt: Accessor<string | undefined>;
  setStatus: (value: AutoTraderStatus) => void;
  state: AutoTraderState;
  flags: {
    stateLoaded: boolean;
    planInFlight: boolean;
    aborted: boolean;
    consecutiveFailures: number;
  };
  timers: { recovery?: ReturnType<typeof setTimeout> };
  /** See withScheduleLock */
  scheduleLock: Promise<unknown>;
};

export function useAutoTrader({ configSignal }: { configSignal: Awaited<ReturnType<typeof get_config_object>> }) {
  const [config, setConfig] = configSignal;
  const { clampedSocAh } = useBatteryValuesProvider();
  const [status, setStatus] = createSignal<AutoTraderStatus>({ enabled: false, note: "starting" });
  const [nextDailyRunAt, setNextDailyRunAt] = createSignal<string | undefined>();
  const enabled = createMemo(() => !!config().automatic_trading?.enabled);

  const ctx: TraderCtx = {
    config,
    setConfig,
    clampedSocAh,
    influxClient: useInfluxClient(),
    enabled,
    nextDailyRunAt,
    setStatus,
    state: structuredClone(EMPTY_STATE),
    flags: { stateLoaded: false, planInFlight: false, aborted: false, consecutiveFailures: 0 },
    timers: {},
    scheduleLock: Promise.resolve(),
  };

  const planAtMemo = createMemo(() => config().automatic_trading?.plan_at_local_time);
  const guardMinutesMemo = createMemo(() => config().automatic_trading?.guard_interval_minutes);
  const replanMinutesMemo = createMemo(() => config().automatic_trading?.opportunistic_replan_interval_minutes ?? 0);

  createEffect(() => {
    if (!enabled()) {
      refreshStatus(ctx, { note: "disabled (automatic_trading.enabled = false)" });
      return;
    }
    ctx.flags.aborted = false;
    // Memos so this effect only rebuilds timers when these values change, not on every config write
    const planAt = planAtMemo();
    const guardMinutes = guardMinutesMemo();
    const replanMinutes = replanMinutesMemo();

    let dailyTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleDaily = () => {
      clearTimeout(dailyTimer); // idempotent — a double call must not leave two timers racing
      const ms = msUntilNextLocalTime(planAt);
      setNextDailyRunAt(new Date(Date.now() + ms).toISOString());
      logLog("Auto trader: next daily plan at", new Date(Date.now() + ms).toISOString(), `(${planAt} Stockholm)`);
      refreshStatus(ctx);
      dailyTimer = setTimeout(async () => {
        await runPlanWithRecovery(ctx, "daily", true);
        void maybeRefitSolarModel(ctx.config, ctx.setConfig, ctx.influxClient);
        void settleRecentDays(
          ctx.influxClient(),
          untrack(config).automatic_trading.price_area,
          untrack(config).automatic_trading,
          ctx.state
        )
          .then(() => refreshStatus(ctx))
          .catch(e => warnLog("Settling recent days after the daily run failed", e));
        scheduleDaily();
      }, ms);
    };

    // The guard only ever shrinks a plan when reality falls short of the forecast. The
    // opportunistic replan is the mirror image: when reality beats the forecast (sunnier day,
    // lower consumption), re-plan and apply only if the projected revenue gain clears
    // opportunistic_replan_min_gain_sek.
    let replanTimer: ReturnType<typeof setInterval> | undefined;
    if (replanMinutes > 0) {
      replanTimer = setInterval(() => {
        if (ctx.flags.planInFlight) return;
        const lastPlanMs = ctx.state.last_plan ? +new Date(ctx.state.last_plan.generated_at) : 0;
        if (Date.now() - lastPlanMs < 45 * 60_000) return; // fresh plan — nothing to improve yet
        const gainGate = untrack(config).automatic_trading.opportunistic_replan_min_gain_sek ?? 5;
        void runPlan(ctx, {
          trigger: "opportunistic",
          waitForTomorrow: false,
          gainGateSek: gainGate,
          keepActiveWindows: true,
        }).then(result => {
          if (result.startsWith("kept existing plan")) debugLog("Auto trader opportunistic:", result);
        });
      }, replanMinutes * 60_000);
    }

    const startupTimer = setTimeout(async () => {
      if (!ctx.flags.stateLoaded) {
        ctx.state = await loadAutoTraderState();
        ctx.flags.stateLoaded = true;
      }
      const lastPlan = ctx.state.last_plan;
      const horizonEnd = lastPlan ? +new Date(lastPlan.horizon_end) : 0;
      const stale = !lastPlan || horizonEnd < Date.now() + 6 * 3600 * 1000;
      if (stale) {
        logLog("Auto trader: no fresh plan on startup — generating one");
        await runPlanWithRecovery(ctx, "startup", false);
      } else {
        reconcileOwnership(ctx, untrack(config));
        await saveAutoTraderState(ctx.state);
        refreshStatus(ctx, { note: "startup: existing plan still fresh" });
      }
      // catch up any recently-completed day the last run missed
      void settleRecentDays(
        ctx.influxClient(),
        untrack(config).automatic_trading.price_area,
        untrack(config).automatic_trading,
        ctx.state
      )
        .then(() => refreshStatus(ctx))
        .catch(e => warnLog("Startup settlement catch-up failed", e));
    }, 90_000);

    scheduleDaily();

    let guardTimer: ReturnType<typeof setInterval> | undefined;
    if (guardMinutes > 0) {
      guardTimer = setInterval(() => void runGuard(ctx), guardMinutes * 60_000);
    }

    onCleanup(() => {
      ctx.flags.aborted = true;
      clearTimeout(startupTimer);
      clearTimeout(dailyTimer);
      clearInterval(guardTimer);
      clearInterval(replanTimer);
      clearTimeout(ctx.timers.recovery);
    });
  });

  return {
    autoTraderStatus: status,
    triggerPlanNow: () => runPlan(ctx, { trigger: "manual", waitForTomorrow: false }),
    clearTradingVetoes: () => clearTradingVetoes(ctx),
  };
}

/**
 * Forget every veto (time ranges blocked because the user deleted planner windows there) and
 * immediately re-plan so the freed ranges get scheduled again. Exposed as a ws action for the
 * frontend's "unblock" button.
 */
async function clearTradingVetoes(ctx: TraderCtx): Promise<string> {
  const cleared = await withScheduleLock(ctx, async () => {
    const count = ctx.state.vetoes.length;
    if (count) {
      ctx.state.vetoes = [];
      await saveAutoTraderState(ctx.state);
    }
    return count;
  });
  refreshStatus(ctx);
  if (!cleared) return "no blocked ranges to clear";
  const summary = await runPlan(ctx, { trigger: "veto-clear", waitForTomorrow: false });
  if (summary === "plan already in progress") {
    // That plan may have sampled the vetoes before the clear — be honest instead of claiming a re-plan
    return `cleared ${cleared} blocked range(s); another plan is running — hit "Generate plan now" afterwards to re-plan the freed ranges`;
  }
  return `cleared ${cleared} blocked range(s); ${summary}`;
}

/**
 * The persisted state must be loaded before anything reads or writes ownership. A manual plan
 * trigger (or an early guard tick) can arrive before the 90-second startup timer has loaded it —
 * on 2026-07-12 that reconciled against the empty boot state, marked every schedule entry
 * user-owned and saved, permanently clobbering ownership. Both loaders are guarded by the same
 * flag, so whichever runs first wins and the other is a no-op.
 */
async function ensureStateLoaded(ctx: TraderCtx) {
  if (ctx.flags.stateLoaded) return;
  ctx.state = await loadAutoTraderState();
  ctx.flags.stateLoaded = true;
}

/**
 * Serializes every read-modify-write of the schedules + ownership state, so a guard run and a
 * plan run can't interleave their setConfig calls and desync owned_entries from the config.
 * The returned promise carries fn's result or rejection to the caller — errors are NOT swallowed.
 * The `.catch` below only detaches the *chain copy* so one rejected run can't poison every
 * subsequent lock acquisition with a stale error.
 */
function withScheduleLock<T>(ctx: TraderCtx, fn: () => Promise<T>): Promise<T> {
  const run = ctx.scheduleLock.then(fn);
  ctx.scheduleLock = run.catch(() => undefined);
  return run;
}

/**
 * Push a fresh status snapshot. The `enabled`/`nextDailyRunAt` reads are wrapped in `untrack`
 * because refreshStatus runs synchronously inside the main createEffect (via scheduleDaily). Without
 * it the effect would subscribe to nextDailyRunAt, and since the daily timer rewrites nextDailyRunAt
 * on every run the effect would tear itself down and rebuild all its timers once a day. Status
 * reporting must never create reactive dependencies.
 */
function refreshStatus(ctx: TraderCtx, extra?: Partial<AutoTraderStatus>) {
  ctx.setStatus(
    untrack(() => ({
      enabled: ctx.enabled(),
      next_daily_run_at: ctx.nextDailyRunAt(),
      last_plan: ctx.state.last_plan,
      vetoes: ctx.state.vetoes,
      guard: ctx.state.guard,
      last_error: ctx.state.last_error,
      last_settlement: ctx.state.last_settlement,
      owned_selling_windows: Object.keys(ctx.state.owned_entries.selling).length,
      owned_buying_windows: Object.keys(ctx.state.owned_entries.buying).length,
      owned_entries: ctx.state.owned_entries,
      ...extra,
    }))
  );
}

/**
 * Compare the live config schedules against the entries we believe we own.
 * - entry present & value-identical → still ours (may be replaced/removed by a new plan)
 * - entry present but value differs → the user edited it: it becomes theirs (fixed window)
 * - entry missing & window not over → the user deleted it: honour a veto for that time range
 *   (unless another entry overlaps the range — then the user merely reshaped the window)
 */
function reconcileOwnership(ctx: TraderCtx, cfg: Config) {
  const now = Date.now();
  const next: AutoTraderState["owned_entries"] = { selling: {}, buying: {} };
  for (const [key, owned] of Object.entries(ctx.state.owned_entries.selling)) {
    const inConfig = cfg.scheduled_power_selling.schedule[key];
    if (inConfig && entriesEqual(inConfig, owned, "power_watts")) {
      next.selling[key] = owned;
    } else if (!inConfig && +new Date(owned.end_time) > now) {
      if (scheduleOverlapsRange(cfg.scheduled_power_selling.schedule, +new Date(key), +new Date(owned.end_time))) {
        logLog("Auto trader: our sell window", key, "was reshaped by the user — theirs now, no veto");
      } else {
        ctx.state.vetoes.push({
          start: key,
          end: owned.end_time,
          kind: "sell",
          noticed_at: new Date(now).toISOString(),
        });
        logLog("Auto trader: user removed our sell window", key, "→ won't re-plan selling in that range");
      }
    }
  }
  for (const [key, owned] of Object.entries(ctx.state.owned_entries.buying)) {
    const inConfig = cfg.scheduled_power_buying.schedule[key];
    if (inConfig && entriesEqual(inConfig, owned, "charging_power")) {
      next.buying[key] = owned;
    } else if (!inConfig && +new Date(owned.end_time) > now) {
      if (scheduleOverlapsRange(cfg.scheduled_power_buying.schedule, +new Date(key), +new Date(owned.end_time))) {
        logLog("Auto trader: our buy window", key, "was reshaped by the user — theirs now, no veto");
      } else {
        ctx.state.vetoes.push({
          start: key,
          end: owned.end_time,
          kind: "buy",
          noticed_at: new Date(now).toISOString(),
        });
        logLog("Auto trader: user removed our buy window", key, "→ won't re-plan buying in that range");
      }
    }
  }
  ctx.state.owned_entries = next;
  ctx.state.vetoes = ctx.state.vetoes.filter(veto => +new Date(veto.end) > now);
}

/** Schedule entries in the config that are NOT ours — the planner must treat them as immutable. */
function userWindows(ctx: TraderCtx, cfg: Config): { sells: FixedWindow[]; buys: FixedWindow[] } {
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

async function buildPlannerInput(
  ctx: TraderCtx,
  cfg: Config,
  prices: FetchedPrices,
  soc: number
): Promise<PlannerInput> {
  const tradingConfig = cfg.automatic_trading;
  const nowMs = Date.now();
  const solar = await fetchSolarForecast(
    tradingConfig.latitude,
    tradingConfig.longitude,
    tradingConfig.solar_model.watts_per_direct_radiation,
    tradingConfig.solar_model.watts_per_diffuse_radiation
  );
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
    elpatron.armed ? cfg.elpatron_switching : undefined
  );
  const { sells, buys } = userWindows(ctx, cfg);
  return {
    nowMs,
    prices: prices.slots,
    solarWattsAt: solar.wattsAt,
    houseLoadWattsAt: ms => consumption.wattsAt(ms) + elpatron.wattsAt(ms),
    // Idle draw and usable capacity now come from the Ah ledger's online-tracked drain/capacity (the Wh
    // fitter's persisted capacity/parasitic state is gone): inverterIdleWatts = drain_a × v_discharge, capacityWh = capacity_ah × v_discharge.
    parasiticWatts: inverterIdleWatts(cfg),
    socPercent: soc,
    capacityWh: packCapacityWh(cfg),
    constraintTailHours: tradingConfig.constraint_tail_hours,
    fixedSells: sells,
    fixedBuys: buys,
    sellVetoWindows: ctx.state.vetoes
      .filter(veto => veto.kind === "sell")
      .map(veto => ({ startMs: +new Date(veto.start), endMs: +new Date(veto.end) })),
    buyVetoWindows: ctx.state.vetoes
      .filter(veto => veto.kind === "buy")
      .map(veto => ({ startMs: +new Date(veto.start), endMs: +new Date(veto.end) })),
    knobs: {
      ...tradingConfig,
      runtime_soc_floor_percent: Number(cfg.scheduled_power_selling.only_sell_above_soc),
      baseline_feed_watts: cfg.feed_from_battery_when_no_solar.feed_amount_watts,
    },
  };
}

/**
 * Write a generated plan into the config schedules. Only entries we own (value-identical to what
 * we last wrote) are replaced; user entries are never touched. `keepOwned` entries survive the
 * replacement and stay ours — used to protect currently-active windows during hourly replans.
 */
function applyPlan(
  ctx: TraderCtx,
  sells: PlannedWindow[],
  buys: PlannedWindow[],
  keepOwned: AutoTraderState["owned_entries"] = { selling: {}, buying: {} }
) {
  const newOwned: AutoTraderState["owned_entries"] = {
    selling: { ...keepOwned.selling },
    buying: { ...keepOwned.buying },
  };
  for (const window of sells) {
    newOwned.selling[new Date(window.startMs).toISOString()] = {
      end_time: new Date(window.endMs).toISOString(),
      power_watts: window.watts,
    };
  }
  for (const window of buys) {
    newOwned.buying[new Date(window.startMs).toISOString()] = {
      end_time: new Date(window.endMs).toISOString(),
      charging_power: window.watts,
    };
  }

  ctx.setConfig(prev => {
    const selling = { ...prev.scheduled_power_selling.schedule };
    const buying = { ...prev.scheduled_power_buying.schedule };
    // Drop every entry we own (value-identical) — the new plan fully replaces our windows,
    // except the ones explicitly kept.
    for (const [key, owned] of Object.entries(ctx.state.owned_entries.selling)) {
      if (keepOwned.selling[key]) continue;
      if (selling[key] && entriesEqual(selling[key], owned, "power_watts")) delete selling[key];
    }
    for (const [key, owned] of Object.entries(ctx.state.owned_entries.buying)) {
      if (keepOwned.buying[key]) continue;
      if (buying[key] && entriesEqual(buying[key], owned, "charging_power")) delete buying[key];
    }
    // Never overwrite an entry the user owns at the same key
    for (const [key, entry] of Object.entries(newOwned.selling)) {
      if (!selling[key]) selling[key] = entry;
      else if (!entriesEqual(selling[key], entry, "power_watts")) delete newOwned.selling[key];
    }
    for (const [key, entry] of Object.entries(newOwned.buying)) {
      if (!buying[key]) buying[key] = entry;
      else if (!entriesEqual(buying[key], entry, "charging_power")) delete newOwned.buying[key];
    }
    // Entries (ours or the user's) whose window ended over a day ago are dead weight in the UI;
    // unparseable dates (NaN) are deliberately kept — deleting what we can't interpret is worse.
    const pruneBeforeMs = Date.now() - 24 * 3600 * 1000;
    const prunedSelling = pickEntries(selling, (_, entry) => !(+new Date(entry.end_time) < pruneBeforeMs));
    const prunedBuying = pickEntries(buying, (_, entry) => !(+new Date(entry.end_time) < pruneBeforeMs));
    // An identical regeneration must be a no-op, not config churn (delete+re-add shuffles key
    // order, so compare with sorted keys)
    if (
      canonicalSchedule(prunedSelling) === canonicalSchedule(prev.scheduled_power_selling.schedule) &&
      canonicalSchedule(prunedBuying) === canonicalSchedule(prev.scheduled_power_buying.schedule)
    ) {
      return prev;
    }
    return {
      ...prev,
      scheduled_power_selling: { ...prev.scheduled_power_selling, schedule: prunedSelling },
      scheduled_power_buying: { ...prev.scheduled_power_buying, schedule: prunedBuying },
    };
  });
  ctx.state.owned_entries = newOwned;
}

type RunPlanOptions = {
  trigger: string;
  /** Wait (retrying) until tomorrow's day-ahead prices are published before planning */
  waitForTomorrow: boolean;
  /**
   * When set, the new plan only replaces the existing windows if its projected revenue beats what
   * the currently-written windows would earn by at least this much (used by the opportunistic
   * replan so a working plan isn't churned for pennies).
   */
  gainGateSek?: number;
  /** Treat currently-executing owned windows as fixed so an in-progress trade is never interrupted */
  keepActiveWindows?: boolean;
  /** Plan with these prices instead of fetching (the guard passes its own, possibly cached, fetch) */
  prices?: FetchedPrices;
};

async function runPlan(ctx: TraderCtx, options: RunPlanOptions): Promise<string> {
  const { trigger, waitForTomorrow, gainGateSek, keepActiveWindows } = options;
  if (ctx.flags.planInFlight) return "plan already in progress";
  ctx.flags.planInFlight = true;
  try {
    await ensureStateLoaded(ctx);
    const tradingConfig = untrack(ctx.config).automatic_trading;

    let prices = options.prices ?? (await fetchPrices(tradingConfig.price_area, trigger === "daily"));
    if (waitForTomorrow && !prices.coversTomorrow) {
      const retryMinutes = Math.max(2, tradingConfig.replan_retry_minutes);
      for (let attempt = 1; attempt <= 16 && !ctx.flags.aborted; attempt++) {
        logLog(`Auto trader: tomorrow's prices not published yet, retry ${attempt}/16 in ${retryMinutes}m`);
        await wait(retryMinutes * 60_000);
        prices = await fetchPrices(tradingConfig.price_area, true).catch(() => prices);
        if (prices.coversTomorrow) break;
      }
    }
    if (ctx.flags.aborted) return "aborted";

    let soc = untrack(ctx.clampedSocAh);
    for (let i = 0; i < 30 && soc === undefined && !ctx.flags.aborted; i++) {
      await wait(10_000);
      soc = untrack(ctx.clampedSocAh);
    }
    if (soc === undefined) throw new Error("SOC not available — cannot plan");
    if (ctx.flags.aborted) return "aborted";

    const plannedSoc = soc;
    const summary = await withScheduleLock(ctx, async () => {
      // Re-read inside the lock: another plan/guard may have written config while we awaited above
      const freshCfg = untrack(ctx.config);
      reconcileOwnership(ctx, freshCfg);

      // A window that is running right now must not be rewritten mid-sell — plan around it
      // and keep it (opportunistic and guard replans; a full plan may reshape everything).
      const keepOwned: AutoTraderState["owned_entries"] = keepActiveWindows
        ? activeOwnedEntries(ctx, Date.now())
        : { selling: {}, buying: {} };

      const input = await buildPlannerInput(ctx, freshCfg, prices, plannedSoc);
      input.fixedSells = [...input.fixedSells, ...ownedEntriesAsWindows(keepOwned.selling, "power_watts")];
      input.fixedBuys = [...input.fixedBuys, ...ownedEntriesAsWindows(keepOwned.buying, "charging_power")];
      const result = generatePlan(input);

      if (gainGateSek !== undefined) {
        // What would the windows currently in the config earn under the same live conditions?
        const existing = projectWithFixedWindows({
          ...input,
          fixedSells: [...input.fixedSells, ...ownedEntriesAsWindows(ctx.state.owned_entries.selling, "power_watts")],
          fixedBuys: [...input.fixedBuys, ...ownedEntriesAsWindows(ctx.state.owned_entries.buying, "charging_power")],
        });
        const gain = result.projection.estimatedRevenueSek - existing.revenueSek;
        if (gain < gainGateSek) {
          return `kept existing plan — replacement would gain ${gain.toFixed(1)} SEK (< ${gainGateSek})`;
        }
        logLog(`Auto trader: opportunistic replan beats current windows by ${gain.toFixed(1)} SEK — applying`);
      }

      applyPlan(ctx, result.sells, result.buys, keepOwned);

      ctx.state.last_plan = {
        generated_at: new Date().toISOString(),
        trigger,
        horizon_end: new Date(prices.horizonEndMs).toISOString(),
        projection: result.projection,
        notes: result.notes,
        soc_series: result.socSeries,
        windows: [...result.sells, ...result.buys].map(window => ({
          start: new Date(window.startMs).toISOString(),
          end: new Date(window.endMs).toISOString(),
          watts: window.watts,
          kind: window.kind,
          reason: window.reason,
          expected_kwh: Math.round(window.expectedKwh * 10) / 10,
          avg_spot: Math.round(window.avgSpot * 1000) / 1000,
        })),
      };
      captureForecastLog(ctx.state, input, result.sells);
      ctx.state.last_error = undefined;
      await saveAutoTraderState(ctx.state);

      return `planned ${result.sells.length} sell + ${result.buys.length} buy window(s), est ${result.projection.estimatedRevenueSek} SEK (baseline ${result.projection.baselineRevenueSek}), min SOC ${result.projection.minSocPercent}% @ ${result.projection.minSocAt}`;
    });
    logLog("Auto trader:", summary);
    if (!summary.startsWith("kept existing plan")) {
      for (const window of ctx.state.last_plan?.windows ?? []) {
        logLog(
          `Auto trader window: ${window.kind} ${window.start} → ${window.end} @ ${window.watts}W — ${window.reason}`
        );
      }
    }
    refreshStatus(ctx);
    return summary;
  } catch (e) {
    ctx.state.last_error = { at: new Date().toISOString(), message: String(e) };
    await saveAutoTraderState(ctx.state);
    errorLog("Auto trader: plan generation failed", e);
    refreshStatus(ctx);
    return `error: ${e}`;
  } finally {
    ctx.flags.planInFlight = false;
  }
}

/**
 * Periodic safety check: with live SOC and fresh forecasts, would the remaining schedule drag SOC
 * below the reserve? If so, re-plan the remaining horizon from live conditions instead of merely
 * trimming: a fresh plan sheds exactly as much selling as needed AND re-adds windows that became
 * feasible again (the old trim-only guard stranded those until someone clicked regenerate — see
 * the 2026-07-06 incident). User windows are never touched; an active window keeps running unless
 * it alone breaches the reserve, in which case it is stubbed to end now.
 *
 * Unlike the old in-lock trim, the shedding lands only when the re-plan's applyPlan finishes (a
 * few seconds later, solar/consumption fetches included). That gap is acceptable because a
 * projected breach concerns windows hours out, and even mid-gap the runtime's own
 * only_sell_above_soc cutoff hard-stops selling regardless of what the schedule says.
 */
async function runGuard(ctx: TraderCtx) {
  if (ctx.flags.planInFlight) {
    debugLog("Auto trader guard: skipped, plan in flight");
    return;
  }
  if (!untrack(ctx.enabled)) {
    debugLog("Auto trader guard: skipped, disabled");
    return;
  }
  const startedAt = Date.now();
  debugLog("Auto trader guard: tick");
  try {
    await ensureStateLoaded(ctx);
    const soc = untrack(ctx.clampedSocAh);
    if (soc === undefined) return;
    const priceArea = untrack(ctx.config).automatic_trading.price_area;
    // For a breach decision slightly stale prices beat no guard run at all
    const prices = (await fetchPrices(priceArea).catch(() => undefined)) ?? getCachedPrices(priceArea);
    if (!prices) {
      debugLog("Auto trader guard: prices unavailable (fetch failed, no cache) — skipping this run");
      return;
    }
    const guardSoc = soc;
    // Phase 1, under the lock: detect a breach and immediately stop an active window that alone
    // causes it. The re-plan itself runs outside the lock (runPlan takes the lock internally).
    const breach = await withScheduleLock(ctx, async () => {
      // Re-read inside the lock — a plan may have rewritten the schedules while we awaited the
      // price fetch, and reconciling against a stale snapshot would spuriously veto its windows
      const cfg = untrack(ctx.config);
      reconcileOwnership(ctx, cfg);

      const baseInput = await buildPlannerInput(ctx, cfg, prices, guardSoc);
      const now = Date.now();
      const ourWindows = ownedEntriesAsWindows(ctx.state.owned_entries.selling, "power_watts").filter(
        window => window.endMs > now
      );
      if (!ourWindows.length) {
        ctx.state.guard = { last_run_at: new Date().toISOString(), last_action: "nothing to guard" };
        return false;
      }

      // Owned buys recharge the battery — projecting the sells without them would fabricate
      // breaches (and could stub a perfectly safe active sell)
      const ourBuyWindows = ownedEntriesAsWindows(ctx.state.owned_entries.buying, "charging_power").filter(
        window => window.endMs > now
      );
      const projectionWith = (windows: typeof ourWindows) =>
        projectWithFixedWindows({
          ...baseInput,
          fixedSells: [...baseInput.fixedSells, ...windows],
          fixedBuys: [...baseInput.fixedBuys, ...ourBuyWindows],
        });

      const projection = projectionWith(ourWindows);
      const tolerable = projectWithFixedWindows(baseInput).violationWh + 1000; // don't blame our windows for a forecast already under water
      if (projection.violationWh <= tolerable) {
        ctx.state.guard = {
          last_run_at: new Date().toISOString(),
          last_action: `ok (projected min SOC ${projection.minSocPercent}% @ ${projection.minSocAt})`,
        };
        return false;
      }

      // The re-plan keeps active windows immutable, so it can't stop one that is itself the
      // problem — that case is handled here, before planning
      const activeWindows = ourWindows.filter(window => window.startMs <= now);
      if (activeWindows.length && projectionWith(activeWindows).violationWh > tolerable) {
        stubActiveSellWindows(ctx, now);
      }
      ctx.state.guard = {
        last_run_at: new Date().toISOString(),
        last_action: `projected reserve breach (min SOC ${projection.minSocPercent}% @ ${projection.minSocAt}) — re-planning`,
      };
      return true;
    });

    if (breach) {
      const summary = await runPlan(ctx, {
        trigger: "guard",
        waitForTomorrow: false,
        keepActiveWindows: true,
        prices,
      });
      if (summary === "plan already in progress") {
        // Whatever plan slipped in re-plans from live conditions anyway; don't claim success here
        ctx.state.guard = {
          last_run_at: new Date().toISOString(),
          last_action: "projected breach; another plan is running — re-checking next tick",
        };
      } else if (summary.startsWith("error:")) {
        // No planner available (e.g. solar forecast fetch died) but the reserve is in danger —
        // shed our future sells rather than keep selling into a projected breach. Owned buys are
        // kept: they only add energy, i.e. help the reserve.
        await withScheduleLock(ctx, async () => {
          const keep = activeOwnedEntries(ctx, Date.now());
          keep.buying = { ...ctx.state.owned_entries.buying };
          applyPlan(ctx, [], [], keep);
        });
        ctx.state.guard = {
          last_run_at: new Date().toISOString(),
          last_action: `re-plan failed (${summary}) — dropped planner sell windows to protect the reserve`,
        };
      } else {
        ctx.state.guard = {
          last_run_at: new Date().toISOString(),
          last_action: `re-planned after projected breach — ${summary}`,
        };
      }
    }
    await saveAutoTraderState(ctx.state);
    refreshStatus(ctx);
    debugLog(`Auto trader guard: done in ${Date.now() - startedAt}ms — ${ctx.state.guard?.last_action}`);
  } catch (e) {
    errorLog(`Auto trader guard failed after ${Date.now() - startedAt}ms (non-fatal)`, e);
  }
}

/**
 * End every currently-running owned sell window in a minute (stub instead of delete so the entry
 * stays visible as history). Used when the active window itself breaches the reserve — the
 * re-plan treats active windows as immutable and could not stop it. The follow-up re-plan then
 * deliberately keeps the ≤60s remnant as a fixed "active" window: deleting it would erase the
 * history, and nothing new can be scheduled into a minute that is already passing.
 */
function stubActiveSellWindows(ctx: TraderCtx, now: number) {
  const activeSelling = activeOwnedEntries(ctx, now).selling;
  const shortenedStubs: Record<string, { end_time: string; power_watts: number }> = {};
  ctx.setConfig(prev => {
    const selling = { ...prev.scheduled_power_selling.schedule };
    for (const [key, owned] of Object.entries(activeSelling)) {
      if (selling[key] && entriesEqual(selling[key], owned, "power_watts")) {
        const stubEnd = new Date(now + 60_000).toISOString();
        selling[key] = { ...selling[key], end_time: stubEnd };
        shortenedStubs[key] = { end_time: stubEnd, power_watts: Number(owned.power_watts) };
      }
    }
    return { ...prev, scheduled_power_selling: { ...prev.scheduled_power_selling, schedule: selling } };
  });
  for (const [key, stub] of Object.entries(shortenedStubs)) {
    ctx.state.owned_entries.selling[key] = stub;
    logLog("Auto trader guard: ending active sell window", key, "now to protect the reserve");
  }
}

/** Owned entries whose window is executing right now (start ≤ now < end). */
function activeOwnedEntries(ctx: TraderCtx, now: number): AutoTraderState["owned_entries"] {
  const isActive = (key: string, entry: { end_time: string }) =>
    +new Date(key) <= now && +new Date(entry.end_time) > now;
  return {
    selling: pickEntries(ctx.state.owned_entries.selling, isActive),
    buying: pickEntries(ctx.state.owned_entries.buying, isActive),
  };
}

/** Object.fromEntries + filter over a schedule/ownership map, preserving the value type. */
function pickEntries<EntryType extends { end_time: string }>(
  entries: Record<string, EntryType>,
  keep: (key: string, entry: EntryType) => boolean
): Record<string, EntryType> {
  return Object.fromEntries(Object.entries(entries).filter(([key, entry]) => keep(key, entry)));
}

/** Schedule serialized with sorted keys — insertion order must not defeat equality checks. */
function canonicalSchedule(schedule: Record<string, { end_time: string }>): string {
  return JSON.stringify(
    Object.keys(schedule)
      .sort()
      .map(key => [key, schedule[key]])
  );
}

/**
 * runPlan + retry: transient failures (undici connect timeouts while the pi is CPU-pegged,
 * upstream hiccups) reschedule another attempt instead of silently waiting for the next day.
 */
async function runPlanWithRecovery(ctx: TraderCtx, trigger: string, waitForTomorrow: boolean): Promise<string> {
  clearTimeout(ctx.timers.recovery);
  const result = await runPlan(ctx, { trigger, waitForTomorrow });
  if (result.startsWith("error:") && !ctx.flags.aborted) {
    ctx.flags.consecutiveFailures++;
    const maxAttempts = 8;
    if (ctx.flags.consecutiveFailures < maxAttempts) {
      const minutes = Math.max(2, untrack(ctx.config).automatic_trading.replan_retry_minutes);
      logLog(
        `Auto trader: plan failed (attempt ${ctx.flags.consecutiveFailures}/${maxAttempts}), retrying in ${minutes}m`
      );
      ctx.timers.recovery = setTimeout(() => void runPlanWithRecovery(ctx, trigger, waitForTomorrow), minutes * 60_000);
    } else {
      errorLog(`Auto trader: giving up after ${maxAttempts} failed plan attempts — next try at the daily run`);
      ctx.flags.consecutiveFailures = 0;
    }
  } else if (!result.startsWith("error:")) {
    ctx.flags.consecutiveFailures = 0;
  }
  return result;
}

function ownedEntriesAsWindows(
  entries: Record<string, { end_time: string }>,
  powerKey: "power_watts" | "charging_power"
): FixedWindow[] {
  return Object.entries(entries).map(([key, entry]) => ({
    startMs: +new Date(key),
    endMs: +new Date(entry.end_time),
    watts: Number((entry as Record<string, unknown>)[powerKey]),
  }));
}

/** True when any schedule entry overlaps [rangeStartMs, rangeEndMs). */
function scheduleOverlapsRange(
  schedule: Record<string, { end_time: string }>,
  rangeStartMs: number,
  rangeEndMs: number
): boolean {
  return Object.entries(schedule).some(([entryKey, entry]) => {
    const entryStartMs = +new Date(entryKey);
    const entryEndMs = +new Date(entry.end_time);
    return isFinite(entryStartMs) && isFinite(entryEndMs) && entryStartMs < rangeEndMs && entryEndMs > rangeStartMs;
  });
}

function entriesEqual(
  a: { end_time: string } & Record<string, unknown>,
  b: { end_time: string } & Record<string, unknown>,
  powerKey: string
) {
  return a.end_time === b.end_time && Number(a[powerKey]) === Number(b[powerKey]);
}
