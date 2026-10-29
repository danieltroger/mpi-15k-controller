/**
 * Which config schedule entries the auto-trader owns, and the schedule reads and writes that hinge on
 * it: reconciling user edits/deletions into ownership and vetoes, writing a plan back into the
 * schedules, and stubbing a running sell window the guard has to stop.
 */

import type { Config } from "../config/config.types.ts";
import { logLog } from "../utilities/logging.ts";
import type { AutoTraderState } from "./autoTraderState.ts";
import type { PlannedWindow } from "./planner.types.ts";
import type { TraderCtx } from "./traderContext.ts";

/** The parts of the trader context the ownership bookkeeping reads and writes */
export type ScheduleOwnershipContext = Pick<TraderCtx, "state" | "setConfig">;

/**
 * Compare the live config schedules against the entries we believe we own.
 * - entry present & value-identical → still ours (may be replaced/removed by a new plan)
 * - entry present but value differs → the user edited it: it becomes theirs (fixed window)
 * - entry missing & window not over → the user deleted it: honour a veto for that time range
 *   (unless another entry overlaps the range — then the user merely reshaped the window)
 */
export function reconcileOwnership(ctx: ScheduleOwnershipContext, cfg: Config) {
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

/**
 * Write a generated plan into the config schedules. Only entries we own (value-identical to what
 * we last wrote) are replaced; user entries are never touched. `keepOwned` entries survive the
 * replacement and stay ours — used to protect currently-active windows during hourly replans.
 */
export function applyPlan(
  ctx: ScheduleOwnershipContext,
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

/**
 * End every currently-running owned sell window in a minute (stub instead of delete so the entry
 * stays visible as history). Used when the active window itself breaches the reserve — the
 * re-plan treats active windows as immutable and could not stop it. The follow-up re-plan then
 * deliberately keeps the ≤60s remnant as a fixed "active" window: deleting it would erase the
 * history, and nothing new can be scheduled into a minute that is already passing.
 */
export function stubActiveSellWindows(ctx: ScheduleOwnershipContext, now: number) {
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
export function activeOwnedEntries(ctx: ScheduleOwnershipContext, now: number): AutoTraderState["owned_entries"] {
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

export function entriesEqual(
  a: { end_time: string } & Record<string, unknown>,
  b: { end_time: string } & Record<string, unknown>,
  powerKey: string
) {
  return a.end_time === b.end_time && Number(a[powerKey]) === Number(b[powerKey]);
}
