/**
 * What the grid-off switch decides, as pure functions of one snapshot (no I/O, no clock): whether the page
 * may switch the inverter to Off-Grid III (151), whether a guard must switch it back to normal hybrid (050),
 * and what to do about a DM readback that disagrees with the request (the startup fail-safe). The wiring is
 * useGridOffSwitch.ts; gridOff.selftest.ts drives these directly.
 */
import type { GridOffConfig } from "../config/config.types.ts";
import type { MachineModelCode } from "../inverterComms/pi17Protocol.types.ts";
import { CONFIRM_GIVE_UP_AFTER_WRITE_MS } from "../inverterComms/schedulerTiming.ts";
import {
  describeMachineModel,
  isWhitelistedMachineModel,
  NORMAL_HYBRID_MODEL,
  OFF_GRID_III_MODEL,
} from "../inverterComms/machineModel.ts";

/**
 * GS and PS arrive about once a second; a minute without them means the serial link is down, and nothing
 * may be switched (or kept switched) on readings that old. A guard constant, not a knob.
 */
export const FRESH_INVERTER_READING_MAX_AGE_MS = 60_000;
/**
 * A requested 151 the DM readback still doesn't show this long after the request is given up (back to
 * 050): past the session's own confirm give-up ("never applied", which pages), plus a settings round.
 */
export const SWITCH_CONFIRM_DEADLINE_MS = CONFIRM_GIVE_UP_AFTER_WRITE_MS + 30_000;

/** A buy or sell schedule as config.json keeps it: start time (ISO) → entry with its end time */
export type ScheduleWindows = Readonly<Record<string, { end_time: string }>>;

export type GridOffSituation = {
  nowMs: number;
  /** THE SOC (the Ah ledger, clamped); undefined = unknown */
  soc: number | undefined;
  /** Age of the older of the GS and PS readings the switch judges; undefined = not read yet */
  inverterReadingAgeMs: number | undefined;
  /** The DM readback, verbatim; undefined = not read yet */
  readbackModel: string | undefined;
  sellSchedule: ScheduleWindows;
  buySchedule: ScheduleWindows;
};

/**
 * Why the page's request for 151 must be refused, or undefined when it may go out. The SOC needs
 * switch_on_soc_margin_percent above the floor the guard reverts at, so the switch can't flap on it.
 */
export function switchOffGridRefusal(situation: GridOffSituation, settings: GridOffConfig): string | undefined {
  const { readbackModel } = situation;
  if (readbackModel === undefined) return "the inverter's machine model (DM) hasn't been read yet";
  if (readbackModel === OFF_GRID_III_MODEL) {
    return "the inverter already reads 151 (Off-Grid III); wait for it to read 050 before switching again";
  }
  if (readbackModel !== NORMAL_HYBRID_MODEL) {
    return `the inverter reports ${describeMachineModel(readbackModel)}; switching is only supported from 050`;
  }
  const staleness = inverterReadingsStaleness(situation.inverterReadingAgeMs);
  if (staleness) return staleness;
  const minimumSoc = settings.min_soc_percent + settings.switch_on_soc_margin_percent;
  if (situation.soc === undefined) return "the SOC is unknown";
  if (situation.soc < minimumSoc) {
    return `SOC ${situation.soc.toFixed(1)} % is below ${minimumSoc} % (grid_off.min_soc_percent ${settings.min_soc_percent} + switch_on_soc_margin_percent ${settings.switch_on_soc_margin_percent})`;
  }
  return windowConflict(situation, settings);
}

/**
 * While 151 is requested: why the guard must switch back to 050, or undefined to stay. `requestedAtMs` is
 * when 151 was requested (for the confirm deadline).
 */
export function revertReason(
  situation: GridOffSituation,
  settings: GridOffConfig,
  requestedAtMs: number
): string | undefined {
  if (situation.soc === undefined) return "the SOC became unknown";
  if (situation.soc < settings.min_soc_percent) {
    return `SOC ${situation.soc.toFixed(1)} % fell below grid_off.min_soc_percent ${settings.min_soc_percent} %`;
  }
  const conflict = windowConflict(situation, settings);
  if (conflict) return conflict;
  const staleness = inverterReadingsStaleness(situation.inverterReadingAgeMs);
  if (staleness) return staleness;
  const sinceRequestMs = situation.nowMs - requestedAtMs;
  if (situation.readbackModel !== OFF_GRID_III_MODEL && sinceRequestMs > SWITCH_CONFIRM_DEADLINE_MS) {
    return `the DM readback shows ${describeMachineModel(situation.readbackModel)} ${Math.round(sinceRequestMs / 1000)} s after 151 was requested (not applied, or changed since)`;
  }
  return undefined;
}

export type MachineModelReconciliation =
  | { action: "none" }
  /** Queue DM050: the inverter reads 151 while the controller wants 050 */
  | { action: "switch_back"; reason: string }
  /** The inverter reports a model the switch never writes: leave it alone, say so */
  | { action: "leave_alone"; reason: string };

/**
 * The DM readback against the request. Grid-off is never kept across a restart: the request starts at 050,
 * so a 151 read at startup (the controller crashed or was killed while off the grid) is switched back, and
 * `firstReadbackSinceStart` only changes what the log says about it.
 */
export function reconcileMachineModel({
  requestedModel,
  readbackModel,
  firstReadbackSinceStart,
}: {
  requestedModel: MachineModelCode;
  readbackModel: string | undefined;
  firstReadbackSinceStart: boolean;
}): MachineModelReconciliation {
  if (readbackModel === undefined) return { action: "none" };
  if (!isWhitelistedMachineModel(readbackModel)) {
    return {
      action: "leave_alone",
      reason: `the inverter reports ${describeMachineModel(readbackModel)}, which the grid-off switch never writes: leaving it alone`,
    };
  }
  if (requestedModel === NORMAL_HYBRID_MODEL && readbackModel === OFF_GRID_III_MODEL) {
    return {
      action: "switch_back",
      reason: firstReadbackSinceStart
        ? "startup fail-safe: the inverter reads 151 (Off-Grid III) as the controller starts, and grid-off is never kept across a restart"
        : "the inverter reads 151 (Off-Grid III) while 050 is requested",
    };
  }
  return { action: "none" };
}

/**
 * A buy or sell window that is active or starts within reconnect_before_window_minutes, described, or
 * undefined. Every window counts, whatever its power: a hold or a 0 W entry still means someone planned the
 * grid. An entry whose times don't parse is skipped: the buy and sell logic never run one either.
 */
export function windowConflict(situation: GridOffSituation, settings: GridOffConfig): string | undefined {
  const leadMs = settings.reconnect_before_window_minutes * 60_000;
  const conflicts = [
    ...scheduleConflicts("sell", situation.sellSchedule, situation.nowMs, leadMs),
    ...scheduleConflicts("buy", situation.buySchedule, situation.nowMs, leadMs),
  ].sort((first, second) => first.startMs - second.startMs);
  const soonest = conflicts[0];
  if (!soonest) return undefined;
  if (soonest.startMs <= situation.nowMs)
    return `a ${soonest.kind} window is active (${soonest.start} → ${soonest.end})`;
  const minutesAway = Math.ceil((soonest.startMs - situation.nowMs) / 60_000);
  return `a ${soonest.kind} window starts in ${minutesAway} min (${soonest.start}), within grid_off.reconnect_before_window_minutes ${settings.reconnect_before_window_minutes}`;
}

type WindowConflict = { kind: "buy" | "sell"; start: string; end: string; startMs: number };

function scheduleConflicts(
  kind: WindowConflict["kind"],
  schedule: ScheduleWindows,
  nowMs: number,
  leadMs: number
): WindowConflict[] {
  return Object.entries(schedule).flatMap(([start, entry]) => {
    const startMs = Date.parse(start);
    const endMs = Date.parse(entry.end_time);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return [];
    if (endMs <= nowMs || startMs - nowMs > leadMs) return [];
    return [{ kind, start, end: entry.end_time, startMs }];
  });
}

function inverterReadingsStaleness(ageMs: number | undefined): string | undefined {
  if (ageMs === undefined) return "no inverter readings (GS/PS) yet";
  if (ageMs > FRESH_INVERTER_READING_MAX_AGE_MS) {
    return `the inverter readings (GS/PS) are ${Math.round(ageMs / 1000)} s old (over ${FRESH_INVERTER_READING_MAX_AGE_MS / 1000} s)`;
  }
  return undefined;
}
