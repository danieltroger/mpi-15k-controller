/**
 * The periodic reserve guard: re-projects the owned schedule from live SOC and fresh forecasts, and when
 * it would breach the reserve re-plans (stopping an active window that alone causes the breach), or drops
 * our future sells if that re-plan fails.
 */

import { untrack } from "solid-js";
import { debugLog, errorLog } from "../utilities/logging.ts";
import { fetchPrices, getCachedPrices } from "./priceService.ts";
import { saveAutoTraderState } from "./autoTraderState.ts";
import { projectWithFixedWindows } from "./planner.ts";
import { activeOwnedEntries, applyPlan, reconcileOwnership, stubActiveSellWindows } from "./scheduleOwnership.ts";
import { buildPlannerInput, ownedEntriesAsWindows } from "./plannerInputs.ts";
import { runPlan } from "./planRun.ts";
import { ensureStateLoaded, refreshStatus, type TraderCtx, withScheduleLock } from "./traderContext.ts";

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
export async function runGuard(ctx: TraderCtx) {
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
