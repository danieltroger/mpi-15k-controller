import { type Accessor, createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js";
import { get_config_object } from "../config/config.ts";
import type { Config } from "../config/config.types.ts";
import { debugLog, errorLog, logLog } from "../utilities/logging.ts";
import { wait } from "../vendor/depictUtilishared.ts";
import { msUntilNextLocalTime } from "../utilities/msUntilNextLocalTime.ts";
import { useInfluxClient } from "../utilities/InfluxClientProvider.ts";
import { fetchPrices, type FetchedPrices, getCachedPrices } from "./priceService.ts";
import { fetchSolarForecast } from "./solarForecast.ts";
import { fetchConsumptionForecast } from "./consumptionForecast.ts";
import { type AutoTraderState, EMPTY_STATE, loadAutoTraderState, saveAutoTraderState } from "./autoTraderState.ts";
import { maybeRefitSolarModel } from "./solarCalibration.ts";
import { captureForecastLog, settleRecentDays } from "./tradingPerformance.ts";
import {
  type FixedWindow,
  generatePlan,
  type PlannerInput,
  type PlannedWindow,
  projectWithFixedWindows,
} from "./planner.ts";

/**
 * Everything the trader's module-level functions share. Passed explicitly instead of closing over
 * a giant outer scope so each function's inputs are visible at the call site (see CLAUDE.md).
 * `state` and `flags` are deliberately mutable.
 */
type TraderCtx = {
  config: Accessor<Config>;
  setConfig: Awaited<ReturnType<typeof get_config_object>>[1];
  averageSOC: Accessor<number | undefined>;
  assumedParasiticConsumption: Accessor<number>;
  influxClient: ReturnType<typeof useInfluxClient>;
  enabled: Accessor<boolean>;
  nextDailyRunAt: Accessor<string | undefined>;
  setStatus: (value: object) => void;
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

export function useAutoTrader({
  configSignal,
  averageSOC,
  assumedParasiticConsumption,
}: {
  configSignal: Awaited<ReturnType<typeof get_config_object>>;
  averageSOC: Accessor<number | undefined>;
  assumedParasiticConsumption: Accessor<number>;
}) {
  const [config, setConfig] = configSignal;
  const [status, setStatus] = createSignal<object>({ enabled: false, note: "starting" });
  const [nextDailyRunAt, setNextDailyRunAt] = createSignal<string | undefined>();
  const enabled = createMemo(() => !!config().automatic_trading?.enabled);

  const ctx: TraderCtx = {
    config,
    setConfig,
    averageSOC,
    assumedParasiticConsumption,
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
        );
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
        void runPlan(ctx, "opportunistic", false, gainGate).then(result => {
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
      );
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
    triggerPlanNow: () => runPlan(ctx, "manual", false),
  };
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

function refreshStatus(ctx: TraderCtx, extra?: object) {
  ctx.setStatus({
    enabled: ctx.enabled(),
    next_daily_run_at: ctx.nextDailyRunAt(),
    last_plan: ctx.state.last_plan,
    vetoes: ctx.state.vetoes,
    guard: ctx.state.guard,
    last_error: ctx.state.last_error,
    owned_selling_windows: Object.keys(ctx.state.owned_entries.selling).length,
    owned_buying_windows: Object.keys(ctx.state.owned_entries.buying).length,
    ...extra,
  });
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
  const solar = await fetchSolarForecast(
    tradingConfig.latitude,
    tradingConfig.longitude,
    tradingConfig.solar_model.watts_per_direct_radiation,
    tradingConfig.solar_model.watts_per_diffuse_radiation
  );
  const consumption = await fetchConsumptionForecast(ctx.influxClient(), tradingConfig.fallback_house_load_watts);
  const { sells, buys } = userWindows(ctx, cfg);
  return {
    nowMs: Date.now(),
    prices: prices.slots,
    solarWattsAt: solar.wattsAt,
    houseLoadWattsAt: consumption.wattsAt,
    parasiticWatts: ctx.assumedParasiticConsumption() || cfg.soc_calculations.current_state.parasitic_consumption,
    socPercent: soc,
    capacityWh: cfg.soc_calculations.current_state.capacity,
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
    return {
      ...prev,
      scheduled_power_selling: { ...prev.scheduled_power_selling, schedule: selling },
      scheduled_power_buying: { ...prev.scheduled_power_buying, schedule: buying },
    };
  });
  ctx.state.owned_entries = newOwned;
}

/**
 * @param onlyIfGainSek when set, the new plan only replaces the existing windows if its projected
 * revenue beats what the currently-written windows would earn by at least this much (used by the
 * opportunistic replan so a working plan isn't churned for pennies). In this mode currently-active
 * windows are also treated as fixed so an in-progress sell is never interrupted.
 */
async function runPlan(
  ctx: TraderCtx,
  trigger: string,
  waitForTomorrow: boolean,
  onlyIfGainSek?: number
): Promise<string> {
  if (ctx.flags.planInFlight) return "plan already in progress";
  ctx.flags.planInFlight = true;
  try {
    const tradingConfig = untrack(ctx.config).automatic_trading;

    let prices = await fetchPrices(tradingConfig.price_area, trigger === "daily");
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

    let soc = untrack(ctx.averageSOC);
    for (let i = 0; i < 30 && soc === undefined && !ctx.flags.aborted; i++) {
      await wait(10_000);
      soc = untrack(ctx.averageSOC);
    }
    if (soc === undefined) throw new Error("SOC not available — cannot plan");
    if (ctx.flags.aborted) return "aborted";

    const plannedSoc = soc;
    const summary = await withScheduleLock(ctx, async () => {
      // Re-read inside the lock: another plan/guard may have written config while we awaited above
      const freshCfg = untrack(ctx.config);
      reconcileOwnership(ctx, freshCfg);

      // During gated (opportunistic) replans, a window that is running right now must not be
      // rewritten mid-sell — plan around it and keep it.
      const now = Date.now();
      const keepOwned: AutoTraderState["owned_entries"] = { selling: {}, buying: {} };
      if (onlyIfGainSek !== undefined) {
        for (const [key, owned] of Object.entries(ctx.state.owned_entries.selling)) {
          if (+new Date(key) <= now && +new Date(owned.end_time) > now) keepOwned.selling[key] = owned;
        }
        for (const [key, owned] of Object.entries(ctx.state.owned_entries.buying)) {
          if (+new Date(key) <= now && +new Date(owned.end_time) > now) keepOwned.buying[key] = owned;
        }
      }

      const input = await buildPlannerInput(ctx, freshCfg, prices, plannedSoc);
      input.fixedSells = [...input.fixedSells, ...ownedEntriesAsWindows(keepOwned.selling, "power_watts")];
      input.fixedBuys = [...input.fixedBuys, ...ownedEntriesAsWindows(keepOwned.buying, "charging_power")];
      const result = generatePlan(input);

      if (onlyIfGainSek !== undefined) {
        // What would the windows currently in the config earn under the same live conditions?
        const existing = projectWithFixedWindows({
          ...input,
          fixedSells: [...input.fixedSells, ...ownedEntriesAsWindows(ctx.state.owned_entries.selling, "power_watts")],
          fixedBuys: [...input.fixedBuys, ...ownedEntriesAsWindows(ctx.state.owned_entries.buying, "charging_power")],
        });
        const gain = result.projection.estimatedRevenueSek - existing.revenueSek;
        if (gain < onlyIfGainSek) {
          return `kept existing plan — replacement would gain ${gain.toFixed(1)} SEK (< ${onlyIfGainSek})`;
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
 * Periodic safety check: with live SOC and fresh forecasts, would the remaining schedule
 * drag SOC below the reserve? If so, trim our windows (never the user's), cheapest first.
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
    const soc = untrack(ctx.averageSOC);
    if (soc === undefined) return;
    const priceArea = untrack(ctx.config).automatic_trading.price_area;
    // For a trim decision slightly stale prices beat no guard run at all
    const prices = (await fetchPrices(priceArea).catch(() => undefined)) ?? getCachedPrices(priceArea);
    if (!prices) {
      debugLog("Auto trader guard: prices unavailable (fetch failed, no cache) — skipping this run");
      return;
    }
    const guardSoc = soc;
    await withScheduleLock(ctx, async () => {
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
        return;
      }

      const projectionWith = (windows: typeof ourWindows) =>
        projectWithFixedWindows({ ...baseInput, fixedSells: [...baseInput.fixedSells, ...windows] });

      const kept = [...ourWindows];
      let projection = projectionWith(kept);
      const tolerable = projectWithFixedWindows(baseInput).violationWh + 1000; // don't blame our windows for a forecast already under water
      let trimmed = 0;
      while (projection.violationWh > tolerable && kept.length) {
        // Sacrifice the least valuable window first (lowest avg spot per state notes, fallback: latest)
        const windowValue = (window: (typeof kept)[number]) => {
          const stateWindow = ctx.state.last_plan?.windows.find(
            candidate => +new Date(candidate.start) === window.startMs && candidate.kind === "sell"
          );
          return stateWindow?.avg_spot ?? 0;
        };
        kept.sort((a, b) => windowValue(a) - windowValue(b));
        const sacrificed = kept.shift()!;
        trimmed++;
        logLog(
          "Auto trader guard: trimming sell window",
          new Date(sacrificed.startMs).toISOString(),
          "to protect reserve (projected min SOC",
          projection.minSocPercent,
          "% )"
        );
        projection = projectionWith(kept);
      }

      if (trimmed) {
        const keptKeys = new Set(kept.map(window => new Date(window.startMs).toISOString()));
        const shortenedStubs: Record<string, { end_time: string; power_watts: number }> = {};
        ctx.setConfig(prev => {
          const selling = { ...prev.scheduled_power_selling.schedule };
          for (const [key, owned] of Object.entries(ctx.state.owned_entries.selling)) {
            if (keptKeys.has(key)) continue;
            if (+new Date(owned.end_time) <= now) continue;
            if (selling[key] && entriesEqual(selling[key], owned, "power_watts")) {
              const startMs = +new Date(key);
              if (startMs <= now) {
                // Active window: end it now instead of deleting so history stays visible
                const stubEnd = new Date(now + 60_000).toISOString();
                selling[key] = { ...selling[key], end_time: stubEnd };
                shortenedStubs[key] = { end_time: stubEnd, power_watts: Number(owned.power_watts) };
              } else {
                delete selling[key];
              }
            }
          }
          return { ...prev, scheduled_power_selling: { ...prev.scheduled_power_selling, schedule: selling } };
        });
        // Ownership: surviving windows, already-finished windows and the just-shortened stub stay ours
        const nextOwned: typeof ctx.state.owned_entries.selling = { ...shortenedStubs };
        for (const key of Object.keys(ctx.state.owned_entries.selling)) {
          if (keptKeys.has(key) || +new Date(ctx.state.owned_entries.selling[key].end_time) <= now) {
            nextOwned[key] = ctx.state.owned_entries.selling[key];
          }
        }
        ctx.state.owned_entries.selling = nextOwned;
      }

      ctx.state.guard = {
        last_run_at: new Date().toISOString(),
        last_action: trimmed
          ? `trimmed ${trimmed} sell window(s), projected min SOC now ${projection.minSocPercent}%`
          : `ok (projected min SOC ${projection.minSocPercent}% @ ${projection.minSocAt})`,
      };
    });
    await saveAutoTraderState(ctx.state);
    refreshStatus(ctx);
    debugLog(`Auto trader guard: done in ${Date.now() - startedAt}ms — ${ctx.state.guard?.last_action}`);
  } catch (e) {
    errorLog(`Auto trader guard failed after ${Date.now() - startedAt}ms (non-fatal)`, e);
  }
}

/**
 * runPlan + retry: transient failures (undici connect timeouts while the pi is CPU-pegged,
 * upstream hiccups) reschedule another attempt instead of silently waiting for the next day.
 */
async function runPlanWithRecovery(ctx: TraderCtx, trigger: string, waitForTomorrow: boolean): Promise<string> {
  clearTimeout(ctx.timers.recovery);
  const result = await runPlan(ctx, trigger, waitForTomorrow);
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
