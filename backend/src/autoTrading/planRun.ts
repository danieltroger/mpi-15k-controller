/**
 * One planning run end to end — wait for prices and SOC, re-plan under the schedule lock, optionally gate
 * the result on its revenue gain, write it to the schedules and record it in the trader state — plus the
 * retrying wrapper the daily and startup runs go through.
 */

import { untrack } from "solid-js";
import { errorLog, logLog } from "../utilities/logging.ts";
import { wait } from "../vendor/depictUtilishared.ts";
import { fetchPrices, type FetchedPrices } from "./priceService.ts";
import { type AutoTraderState, saveAutoTraderState } from "./autoTraderState.ts";
import { captureForecastLog } from "./tradingPerformance.ts";
import { generatePlan, projectWithFixedWindows } from "./planner.ts";
import { activeOwnedEntries, applyPlan, reconcileOwnership } from "./scheduleOwnership.ts";
import { buildPlannerInput, ownedEntriesAsWindows } from "./plannerInputs.ts";
import { ensureStateLoaded, refreshStatus, type TraderCtx, withScheduleLock } from "./traderContext.ts";

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

export async function runPlan(ctx: TraderCtx, options: RunPlanOptions): Promise<string> {
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
 * runPlan + retry: transient failures (undici connect timeouts while the pi is CPU-pegged,
 * upstream hiccups) reschedule another attempt instead of silently waiting for the next day.
 */
export async function runPlanWithRecovery(ctx: TraderCtx, trigger: string, waitForTomorrow: boolean): Promise<string> {
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
