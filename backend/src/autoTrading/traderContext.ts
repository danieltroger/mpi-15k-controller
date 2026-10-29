/**
 * The auto-trader's shared context (TraderCtx) and the primitives every trader operation runs on it:
 * loading the persisted ownership state before first use, the schedule lock, and the status snapshot.
 */

import { type Accessor, untrack } from "solid-js";
import type { get_config_object } from "../config/config.ts";
import type { Config } from "../config/config.types.ts";
import type { useInfluxClient } from "../utilities/InfluxClientProvider.ts";
import type { MqttValue } from "../sharedTypes.ts";
import { type AutoTraderState, type AutoTraderStatus, loadAutoTraderState } from "./autoTraderState.ts";

/**
 * Everything the trader's module-level functions share. Passed explicitly instead of closing over
 * a giant outer scope so each function's inputs are visible at the call site (see CLAUDE.md).
 * `state` and `flags` are deliberately mutable.
 */
export type TraderCtx = {
  config: Accessor<Config>;
  setConfig: Awaited<ReturnType<typeof get_config_object>>[1];
  /** Ah-ledger SOC clamped to [0,100] — the planner must never project from a nonsensical <0 / >100 start. */
  clampedSocAh: Accessor<number | undefined>;
  /** The inverter's latest ac_input_total_active_power (negative while feeding) and when it arrived */
  gridPowerReading: Accessor<MqttValue | undefined>;
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
    /** The last planner input found no fresh grid power reading (see logMeasuredFeedInFreshnessChange) */
    measuredFeedInStale: boolean;
  };
  timers: { recovery?: ReturnType<typeof setTimeout> };
  /** See withScheduleLock */
  scheduleLock: Promise<unknown>;
};

/**
 * The persisted state must be loaded before anything reads or writes ownership. A manual plan
 * trigger (or an early guard tick) can arrive before the 90-second startup timer has loaded it —
 * on 2026-07-12 that reconciled against the empty boot state, marked every schedule entry
 * user-owned and saved, permanently clobbering ownership. Both loaders are guarded by the same
 * flag, so whichever runs first wins and the other is a no-op.
 */
export async function ensureStateLoaded(ctx: TraderCtx) {
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
export function withScheduleLock<T>(ctx: TraderCtx, fn: () => Promise<T>): Promise<T> {
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
export function refreshStatus(ctx: TraderCtx, extra?: Partial<AutoTraderStatus>) {
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
