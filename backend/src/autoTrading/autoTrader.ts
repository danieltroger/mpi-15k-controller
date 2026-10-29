/**
 * The auto-trader's reactive wiring: builds the shared TraderCtx and drives everything from timers — the
 * daily plan, the startup catch-up, the reserve guard (reserveGuard.ts) and the opportunistic replan —
 * plus the ws actions. A planning run lives in planRun.ts, its input assembly in plannerInputs.ts and the
 * schedule ownership bookkeeping in scheduleOwnership.ts.
 */

import { createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js";
import { get_config_object } from "../config/config.ts";
import { debugLog, logLog, warnLog } from "../utilities/logging.ts";
import { msUntilNextLocalTime } from "../utilities/msUntilNextLocalTime.ts";
import { useInfluxClient } from "../utilities/InfluxClientProvider.ts";
import { useBatteryValuesProvider } from "../battery/BatteryValuesProvider.ts";
import { useFromMqttProvider } from "../mqttValues/MQTTValuesProvider.ts";
import { type AutoTraderStatus, EMPTY_STATE, loadAutoTraderState, saveAutoTraderState } from "./autoTraderState.ts";
import { settleRecentDays } from "./tradingPerformance.ts";
import { refreshStatus, type TraderCtx, withScheduleLock } from "./traderContext.ts";
import { reconcileOwnership } from "./scheduleOwnership.ts";
import { runPlan, runPlanWithRecovery } from "./planRun.ts";
import { runGuard } from "./reserveGuard.ts";

export function useAutoTrader({ configSignal }: { configSignal: Awaited<ReturnType<typeof get_config_object>> }) {
  const [config, setConfig] = configSignal;
  const { clampedSocAh } = useBatteryValuesProvider();
  const { mqttValues } = useFromMqttProvider();
  const [status, setStatus] = createSignal<AutoTraderStatus>({ enabled: false, note: "starting" });
  const [nextDailyRunAt, setNextDailyRunAt] = createSignal<string | undefined>();
  const enabled = createMemo(() => !!config().automatic_trading?.enabled);

  const ctx: TraderCtx = {
    config,
    setConfig,
    clampedSocAh,
    gridPowerReading: () => mqttValues.ac_input_total_active_power,
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
