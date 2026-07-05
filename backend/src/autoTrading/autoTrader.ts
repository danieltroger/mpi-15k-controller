import { type Accessor, createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js";
import { get_config_object } from "../config/config.ts";
import type { Config } from "../config/config.types.ts";
import { debugLog, errorLog, logLog } from "../utilities/logging.ts";
import { wait } from "../vendor/depictUtilishared.ts";
import { msUntilNextLocalTime } from "../utilities/msUntilNextLocalTime.ts";
import { useInfluxClient } from "../utilities/useInfluxClient.ts";
import { fetchPrices, type FetchedPrices, getCachedPrices } from "./priceService.ts";
import { fetchSolarForecast } from "./solarForecast.ts";
import { fetchConsumptionForecast } from "./consumptionForecast.ts";
import { type AutoTraderState, EMPTY_STATE, loadAutoTraderState, saveAutoTraderState } from "./autoTraderState.ts";
import {
  type FixedWindow,
  generatePlan,
  type PlannerInput,
  type PlannedWindow,
  projectWithFixedWindows,
} from "./planner.ts";

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

  let state: AutoTraderState = structuredClone(EMPTY_STATE);
  let stateLoaded = false;
  let planInFlight = false;
  let aborted = false;
  let consecutiveFailures = 0;
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  // Serializes every read-modify-write of the schedules + ownership state, so a guard run and a
  // plan run can't interleave their setConfig calls and desync owned_entries from the config.
  let scheduleLock: Promise<unknown> = Promise.resolve();
  function withScheduleLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = scheduleLock.then(fn);
    scheduleLock = run.catch(() => undefined);
    return run;
  }

  const enabled = createMemo(() => !!config().automatic_trading?.enabled);

  const influxClient = useInfluxClient(config);

  function refreshStatus(extra?: object) {
    setStatus({
      enabled: enabled(),
      next_daily_run_at: nextDailyRunAt(),
      last_plan: state.last_plan,
      vetoes: state.vetoes,
      guard: state.guard,
      last_error: state.last_error,
      owned_selling_windows: Object.keys(state.owned_entries.selling).length,
      owned_buying_windows: Object.keys(state.owned_entries.buying).length,
      ...extra,
    });
  }

  /**
   * Compare the live config schedules against the entries we believe we own.
   * - entry present & value-identical → still ours (may be replaced/removed by a new plan)
   * - entry present but value differs → the user edited it: it becomes theirs (fixed window)
   * - entry missing & window not over → the user deleted it: honour a veto for that time range
   */
  function reconcileOwnership(cfg: Config) {
    const now = Date.now();
    const next: AutoTraderState["owned_entries"] = { selling: {}, buying: {} };
    // A vanished owned key whose range is covered by another entry isn't a deletion — the user
    // reshaped the window (e.g. merged two windows into one). Only a bare removal is a veto.
    const overlapsAnyEntry = (schedule: Record<string, { end_time: string }>, startMs: number, endMs: number) =>
      Object.entries(schedule).some(([k, e]) => {
        const s = +new Date(k);
        const en = +new Date(e.end_time);
        return isFinite(s) && isFinite(en) && s < endMs && en > startMs;
      });
    for (const [key, owned] of Object.entries(state.owned_entries.selling)) {
      const inConfig = cfg.scheduled_power_selling.schedule[key];
      if (inConfig && entriesEqual(inConfig, owned, "power_watts")) {
        next.selling[key] = owned;
      } else if (!inConfig && +new Date(owned.end_time) > now) {
        if (overlapsAnyEntry(cfg.scheduled_power_selling.schedule, +new Date(key), +new Date(owned.end_time))) {
          logLog("Auto trader: our sell window", key, "was reshaped by the user — theirs now, no veto");
        } else {
          state.vetoes.push({ start: key, end: owned.end_time, kind: "sell", noticed_at: new Date(now).toISOString() });
          logLog("Auto trader: user removed our sell window", key, "→ won't re-plan selling in that range");
        }
      }
    }
    for (const [key, owned] of Object.entries(state.owned_entries.buying)) {
      const inConfig = cfg.scheduled_power_buying.schedule[key];
      if (inConfig && entriesEqual(inConfig, owned, "charging_power")) {
        next.buying[key] = owned;
      } else if (!inConfig && +new Date(owned.end_time) > now) {
        if (overlapsAnyEntry(cfg.scheduled_power_buying.schedule, +new Date(key), +new Date(owned.end_time))) {
          logLog("Auto trader: our buy window", key, "was reshaped by the user — theirs now, no veto");
        } else {
          state.vetoes.push({ start: key, end: owned.end_time, kind: "buy", noticed_at: new Date(now).toISOString() });
          logLog("Auto trader: user removed our buy window", key, "→ won't re-plan buying in that range");
        }
      }
    }
    state.owned_entries = next;
    state.vetoes = state.vetoes.filter(v => +new Date(v.end) > now);
  }

  function userWindows(cfg: Config): { sells: FixedWindow[]; buys: FixedWindow[] } {
    const sells: FixedWindow[] = [];
    const buys: FixedWindow[] = [];
    for (const [key, entry] of Object.entries(cfg.scheduled_power_selling.schedule)) {
      const owned = state.owned_entries.selling[key];
      if (owned && entriesEqual(entry, owned, "power_watts")) continue;
      const startMs = +new Date(key);
      const endMs = +new Date(entry.end_time);
      if (isFinite(startMs) && isFinite(endMs)) sells.push({ startMs, endMs, watts: Number(entry.power_watts) || 0 });
    }
    for (const [key, entry] of Object.entries(cfg.scheduled_power_buying.schedule)) {
      const owned = state.owned_entries.buying[key];
      if (owned && entriesEqual(entry, owned, "charging_power")) continue;
      const startMs = +new Date(key);
      const endMs = +new Date(entry.end_time);
      if (isFinite(startMs) && isFinite(endMs)) buys.push({ startMs, endMs, watts: Number(entry.charging_power) || 0 });
    }
    return { sells, buys };
  }

  async function buildPlannerInput(cfg: Config, prices: FetchedPrices, soc: number): Promise<PlannerInput> {
    const at = cfg.automatic_trading;
    const solar = await fetchSolarForecast(
      at.latitude,
      at.longitude,
      at.solar_model.watts_per_direct_radiation,
      at.solar_model.watts_per_diffuse_radiation
    );
    const consumption = await fetchConsumptionForecast(influxClient(), at.fallback_house_load_watts);
    const { sells, buys } = userWindows(cfg);
    return {
      nowMs: Date.now(),
      prices: prices.slots,
      solarWattsAt: solar.wattsAt,
      houseLoadWattsAt: consumption.wattsAt,
      parasiticWatts: assumedParasiticConsumption() || cfg.soc_calculations.current_state.parasitic_consumption,
      socPercent: soc,
      capacityWh: cfg.soc_calculations.current_state.capacity,
      constraintTailHours: at.constraint_tail_hours,
      fixedSells: sells,
      fixedBuys: buys,
      sellVetoWindows: state.vetoes
        .filter(v => v.kind === "sell")
        .map(v => ({ startMs: +new Date(v.start), endMs: +new Date(v.end) })),
      buyVetoWindows: state.vetoes
        .filter(v => v.kind === "buy")
        .map(v => ({ startMs: +new Date(v.start), endMs: +new Date(v.end) })),
      knobs: {
        ...at,
        runtime_soc_floor_percent: Number(cfg.scheduled_power_selling.only_sell_above_soc),
        baseline_feed_watts: cfg.feed_from_battery_when_no_solar.feed_amount_watts,
      },
    };
  }

  function applyPlan(sells: PlannedWindow[], buys: PlannedWindow[]) {
    const newOwned: AutoTraderState["owned_entries"] = { selling: {}, buying: {} };
    for (const w of sells) {
      newOwned.selling[new Date(w.startMs).toISOString()] = {
        end_time: new Date(w.endMs).toISOString(),
        power_watts: w.watts,
      };
    }
    for (const w of buys) {
      newOwned.buying[new Date(w.startMs).toISOString()] = {
        end_time: new Date(w.endMs).toISOString(),
        charging_power: w.watts,
      };
    }

    setConfig(prev => {
      const selling = { ...prev.scheduled_power_selling.schedule };
      const buying = { ...prev.scheduled_power_buying.schedule };
      // Drop every entry we own (value-identical) — the new plan fully replaces our windows.
      for (const [key, owned] of Object.entries(state.owned_entries.selling)) {
        if (selling[key] && entriesEqual(selling[key], owned, "power_watts")) delete selling[key];
      }
      for (const [key, owned] of Object.entries(state.owned_entries.buying)) {
        if (buying[key] && entriesEqual(buying[key], owned, "charging_power")) delete buying[key];
      }
      // Never overwrite an entry the user owns at the same key
      for (const [key, entry] of Object.entries(newOwned.selling)) {
        if (!selling[key]) selling[key] = entry;
        else delete newOwned.selling[key];
      }
      for (const [key, entry] of Object.entries(newOwned.buying)) {
        if (!buying[key]) buying[key] = entry;
        else delete newOwned.buying[key];
      }
      return {
        ...prev,
        scheduled_power_selling: { ...prev.scheduled_power_selling, schedule: selling },
        scheduled_power_buying: { ...prev.scheduled_power_buying, schedule: buying },
      };
    });
    state.owned_entries = newOwned;
  }

  async function runPlan(trigger: string, waitForTomorrow: boolean): Promise<string> {
    if (planInFlight) return "plan already in progress";
    planInFlight = true;
    try {
      const cfg = untrack(config);
      const at = cfg.automatic_trading;

      let prices = await fetchPrices(at.price_area, trigger === "daily");
      if (waitForTomorrow && !prices.coversTomorrow) {
        const retryMinutes = Math.max(2, at.replan_retry_minutes);
        for (let attempt = 1; attempt <= 16 && !aborted; attempt++) {
          logLog(`Auto trader: tomorrow's prices not published yet, retry ${attempt}/16 in ${retryMinutes}m`);
          await wait(retryMinutes * 60_000);
          prices = await fetchPrices(at.price_area, true).catch(() => prices);
          if (prices.coversTomorrow) break;
        }
      }
      if (aborted) return "aborted";

      let soc = untrack(averageSOC);
      for (let i = 0; i < 30 && soc === undefined && !aborted; i++) {
        await wait(10_000);
        soc = untrack(averageSOC);
      }
      if (soc === undefined) throw new Error("SOC not available — cannot plan");
      if (aborted) return "aborted";

      const plannedSoc = soc;
      const summary = await withScheduleLock(async () => {
        const freshCfg = untrack(config);
        reconcileOwnership(freshCfg);
        const input = await buildPlannerInput(freshCfg, prices, plannedSoc);
        const result = generatePlan(input);

        applyPlan(result.sells, result.buys);

        state.last_plan = {
          generated_at: new Date().toISOString(),
          trigger,
          horizon_end: new Date(prices.horizonEndMs).toISOString(),
          projection: result.projection,
          notes: result.notes,
          windows: [...result.sells, ...result.buys].map(w => ({
            start: new Date(w.startMs).toISOString(),
            end: new Date(w.endMs).toISOString(),
            watts: w.watts,
            kind: w.kind,
            reason: w.reason,
            expected_kwh: Math.round(w.expectedKwh * 10) / 10,
            avg_spot: Math.round(w.avgSpot * 1000) / 1000,
          })),
        };
        state.last_error = undefined;
        await saveAutoTraderState(state);

        return `planned ${result.sells.length} sell + ${result.buys.length} buy window(s), est ${result.projection.estimatedRevenueSek} SEK (baseline ${result.projection.baselineRevenueSek}), min SOC ${result.projection.minSocPercent}% @ ${result.projection.minSocAt}`;
      });
      logLog("Auto trader:", summary);
      for (const w of state.last_plan?.windows ?? []) {
        logLog(`Auto trader window: ${w.kind} ${w.start} → ${w.end} @ ${w.watts}W — ${w.reason}`);
      }
      refreshStatus();
      return summary;
    } catch (e) {
      state.last_error = { at: new Date().toISOString(), message: String(e) };
      await saveAutoTraderState(state);
      errorLog("Auto trader: plan generation failed", e);
      refreshStatus();
      return `error: ${e}`;
    } finally {
      planInFlight = false;
    }
  }

  /**
   * Periodic safety check: with live SOC and fresh forecasts, would the remaining schedule
   * drag SOC below the reserve? If so, trim our windows (never the user's), cheapest first.
   */
  async function runGuard() {
    if (planInFlight) {
      debugLog("Auto trader guard: skipped, plan in flight");
      return;
    }
    if (!untrack(enabled)) {
      debugLog("Auto trader guard: skipped, disabled");
      return;
    }
    const startedAt = Date.now();
    debugLog("Auto trader guard: tick");
    try {
      const cfg = untrack(config);
      const soc = untrack(averageSOC);
      if (soc === undefined) return;
      const at = cfg.automatic_trading;
      // For a trim decision slightly stale prices beat no guard run at all
      const prices = (await fetchPrices(at.price_area).catch(() => undefined)) ?? getCachedPrices(at.price_area);
      if (!prices) {
        debugLog("Auto trader guard: prices unavailable (fetch failed, no cache) — skipping this run");
        return;
      }
      const guardSoc = soc;
      await withScheduleLock(async () => {
        reconcileOwnership(cfg);

        const baseInput = await buildPlannerInput(cfg, prices, guardSoc);
        const now = Date.now();
        const ourWindows = Object.entries(state.owned_entries.selling)
          .map(([key, e]) => ({ startMs: +new Date(key), endMs: +new Date(e.end_time), watts: Number(e.power_watts) }))
          .filter(w => w.endMs > now);
        if (!ourWindows.length) {
          state.guard = { last_run_at: new Date().toISOString(), last_action: "nothing to guard" };
          return;
        }

        const projectionWith = (windows: typeof ourWindows) =>
          projectWithFixedWindows({ ...baseInput, fixedSells: [...baseInput.fixedSells, ...windows] });

        let kept = [...ourWindows];
        let projection = projectionWith(kept);
        const tolerable = projectWithFixedWindows(baseInput).violationWh + 1000; // don't blame our windows for a forecast already under water
        let trimmed = 0;
        while (projection.violationWh > tolerable && kept.length) {
          // Sacrifice the least valuable window first (lowest avg spot per state notes, fallback: latest)
          const value = (w: (typeof kept)[number]) => {
            const sw = state.last_plan?.windows.find(x => +new Date(x.start) === w.startMs && x.kind === "sell");
            return sw?.avg_spot ?? 0;
          };
          kept.sort((a, b) => value(a) - value(b));
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
          const keptKeys = new Set(kept.map(w => new Date(w.startMs).toISOString()));
          const shortenedStubs: Record<string, { end_time: string; power_watts: number }> = {};
          setConfig(prev => {
            const selling = { ...prev.scheduled_power_selling.schedule };
            for (const [key, owned] of Object.entries(state.owned_entries.selling)) {
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
          const nextOwned: typeof state.owned_entries.selling = { ...shortenedStubs };
          for (const key of Object.keys(state.owned_entries.selling)) {
            if (keptKeys.has(key) || +new Date(state.owned_entries.selling[key].end_time) <= now) {
              nextOwned[key] = state.owned_entries.selling[key];
            }
          }
          state.owned_entries.selling = nextOwned;
        }

        state.guard = {
          last_run_at: new Date().toISOString(),
          last_action: trimmed
            ? `trimmed ${trimmed} sell window(s), projected min SOC now ${projection.minSocPercent}%`
            : `ok (projected min SOC ${projection.minSocPercent}% @ ${projection.minSocAt})`,
        };
      });
      await saveAutoTraderState(state);
      refreshStatus();
      debugLog(`Auto trader guard: done in ${Date.now() - startedAt}ms — ${state.guard?.last_action}`);
    } catch (e) {
      errorLog(`Auto trader guard failed after ${Date.now() - startedAt}ms (non-fatal)`, e);
    }
  }

  // ---- timers ----
  /**
   * runPlan + retry: transient failures (undici connect timeouts while the pi is CPU-pegged,
   * upstream hiccups) reschedule another attempt instead of silently waiting for the next day.
   */
  async function runPlanWithRecovery(trigger: string, waitForTomorrow: boolean): Promise<string> {
    clearTimeout(recoveryTimer);
    const result = await runPlan(trigger, waitForTomorrow);
    if (result.startsWith("error:") && !aborted) {
      consecutiveFailures++;
      const maxAttempts = 8;
      if (consecutiveFailures < maxAttempts) {
        const minutes = Math.max(2, untrack(config).automatic_trading.replan_retry_minutes);
        logLog(`Auto trader: plan failed (attempt ${consecutiveFailures}/${maxAttempts}), retrying in ${minutes}m`);
        recoveryTimer = setTimeout(() => void runPlanWithRecovery(trigger, waitForTomorrow), minutes * 60_000);
      } else {
        errorLog(`Auto trader: giving up after ${maxAttempts} failed plan attempts — next try at the daily run`);
        consecutiveFailures = 0;
      }
    } else if (!result.startsWith("error:")) {
      consecutiveFailures = 0;
    }
    return result;
  }

  const planAtMemo = createMemo(() => config().automatic_trading?.plan_at_local_time);
  const guardMinutesMemo = createMemo(() => config().automatic_trading?.guard_interval_minutes);
  createEffect(() => {
    if (!enabled()) {
      refreshStatus({ note: "disabled (automatic_trading.enabled = false)" });
      return;
    }
    aborted = false;
    // Memos so this effect only rebuilds timers when these values change, not on every config write
    const planAt = planAtMemo();
    const guardMinutes = guardMinutesMemo();

    let dailyTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleDaily = () => {
      const ms = msUntilNextLocalTime(planAt);
      setNextDailyRunAt(new Date(Date.now() + ms).toISOString());
      logLog("Auto trader: next daily plan at", new Date(Date.now() + ms).toISOString(), `(${planAt} Stockholm)`);
      refreshStatus();
      dailyTimer = setTimeout(async () => {
        await runPlanWithRecovery("daily", true);
        scheduleDaily();
      }, ms);
    };

    const startupTimer = setTimeout(async () => {
      if (!stateLoaded) {
        state = await loadAutoTraderState();
        stateLoaded = true;
      }
      const lastPlan = state.last_plan;
      const horizonEnd = lastPlan ? +new Date(lastPlan.horizon_end) : 0;
      const stale = !lastPlan || horizonEnd < Date.now() + 6 * 3600 * 1000;
      if (stale) {
        logLog("Auto trader: no fresh plan on startup — generating one");
        await runPlanWithRecovery("startup", false);
      } else {
        reconcileOwnership(untrack(config));
        await saveAutoTraderState(state);
        refreshStatus({ note: "startup: existing plan still fresh" });
      }
    }, 90_000);

    scheduleDaily();

    let guardTimer: ReturnType<typeof setInterval> | undefined;
    if (guardMinutes > 0) {
      guardTimer = setInterval(() => void runGuard(), guardMinutes * 60_000);
    }

    onCleanup(() => {
      aborted = true;
      clearTimeout(startupTimer);
      clearTimeout(dailyTimer);
      clearInterval(guardTimer);
      clearTimeout(recoveryTimer);
    });
  });

  return {
    autoTraderStatus: status,
    triggerPlanNow: () => runPlan("manual", false),
  };
}

function entriesEqual(
  a: { end_time: string } & Record<string, unknown>,
  b: { end_time: string } & Record<string, unknown>,
  powerKey: string
) {
  return a.end_time === b.end_time && Number(a[powerKey]) === Number(b[powerKey]);
}
