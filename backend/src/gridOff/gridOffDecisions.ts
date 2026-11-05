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
/**
 * While the inverter reads 151 and 050 is wanted, DM050 goes out again 1, 2 and 5 min after the previous
 * send, then every 10 min: each one is a settings write, and a firmware that refuses the change while
 * running would otherwise take one a minute for as long as it lasts. A guard constant (EEPROM wear).
 */
export const SWITCH_BACK_RESEND_INTERVALS_MS: readonly number[] = [60_000, 120_000, 300_000, 600_000];

/** A buy or sell schedule as config.json keeps it: start time (ISO) → entry with its end time */
export type ScheduleWindows = Readonly<Record<string, { end_time: string }>>;

export type GridOffSituation = {
  nowMs: number;
  /** THE SOC (the Ah ledger, clamped); undefined = unknown */
  soc: number | undefined;
  /**
   * Age of the latest hall sensor 2 sample, the current the SOC integrates; undefined = none yet. The SOC never
   * goes unknown when the samples stop: it keeps moving by the drain term alone, so this is what says it's stale
   */
  socReadingAgeMs: number | undefined;
  /** Age of the older of the GS and PS readings the switch judges; undefined = not read yet */
  inverterReadingAgeMs: number | undefined;
  /** The DM readback, verbatim; undefined = not read yet */
  readbackModel: string | undefined;
  /** How old that readback is (wall clock); undefined = not read yet */
  readbackAgeMs: number | undefined;
  /** The oldest DM readback a switch to 151 may rely on (machineModelReadbackMaxAgeMs) */
  readbackMaxAgeMs: number;
  /** The latest switch either way (page, automatic, guard or startup fail-safe); undefined = none since the start */
  lastSwitchAtMs: number | undefined;
  sellSchedule: ScheduleWindows;
  buySchedule: ScheduleWindows;
};

/** Two settings rounds and a minute: an older DM readback means DM isn't being polled (off, or backed off) */
export function machineModelReadbackMaxAgeMs(pollValuesIntervalSeconds: number): number {
  return 2 * pollValuesIntervalSeconds * 1000 + 60_000;
}

/**
 * Why the page's request for 151 must be refused, or undefined when it may go out. The SOC needs
 * switch_on_soc_margin_percent above the floor the guard reverts at, so the switch can't flap on it.
 */
export function switchOffGridRefusal(situation: GridOffSituation, settings: GridOffConfig): string | undefined {
  const { readbackModel, readbackAgeMs } = situation;
  if (!settings.poll_machine_model) return "grid_off.poll_machine_model is off: no DM readback to confirm a switch";
  if (readbackModel === undefined || readbackAgeMs === undefined) {
    return "the inverter's machine model (DM) hasn't been read yet";
  }
  if (readbackAgeMs > situation.readbackMaxAgeMs) {
    return `the DM readback is ${Math.round(readbackAgeMs / 60_000)} min old (DM polling backed off after failures?)`;
  }
  if (readbackModel === OFF_GRID_III_MODEL) {
    return "the inverter already reads 151 (Off-Grid III); wait for it to read 050 before switching again";
  }
  if (readbackModel !== NORMAL_HYBRID_MODEL) {
    return `the inverter reports ${describeMachineModel(readbackModel)}; switching is only supported from 050`;
  }
  if (situation.lastSwitchAtMs !== undefined) {
    const sinceSwitchMs = situation.nowMs - situation.lastSwitchAtMs;
    if (sinceSwitchMs < settings.min_seconds_between_switches * 1000) {
      return `the last switch was ${Math.round(sinceSwitchMs / 1000)} s ago (grid_off.min_seconds_between_switches ${settings.min_seconds_between_switches})`;
    }
  }
  const staleness = inverterReadingsStaleness(situation.inverterReadingAgeMs);
  if (staleness) return staleness;
  const socStaleness = socReadingStaleness(situation.socReadingAgeMs);
  if (socStaleness) return socStaleness;
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
  return revertCause(situation, settings, requestedAtMs)?.reason;
}

/** What made the guard switch back: a window or the floor are routine, the rest mean the 151 didn't hold */
export type RevertCauseKind = "soc_unknown" | "soc_low" | "window" | "stale_readings" | "stale_soc" | "not_applied";

export type RevertCause = {
  kind: RevertCauseKind;
  reason: string;
  /** The window that is active or within the lead, for kind "window" */
  window: ScheduledWindow | undefined;
};

/**
 * The causes after which the 151 didn't hold: automatic grid-off backs off its next try for them
 * (autoGridOffDecisions.ts), so a link or a sensor dropping every few minutes can't cycle the relay. A window
 * and the SOC floor aren't: either 10 s timer may make those first, the guard's or automatic grid-off's.
 */
export const FAILED_SWITCH_REVERT_KINDS: ReadonlySet<RevertCauseKind> = new Set([
  "soc_unknown",
  "stale_readings",
  "stale_soc",
  "not_applied",
]);

/** revertReason, with which rule made it */
export function revertCause(
  situation: GridOffSituation,
  settings: GridOffConfig,
  requestedAtMs: number
): RevertCause | undefined {
  if (situation.soc === undefined) return cause("soc_unknown", "the SOC became unknown");
  if (situation.soc < settings.min_soc_percent) {
    return cause(
      "soc_low",
      `SOC ${situation.soc.toFixed(1)} % fell below grid_off.min_soc_percent ${settings.min_soc_percent} %`
    );
  }
  const window = conflictingWindow(
    scheduledWindows(situation.sellSchedule, situation.buySchedule, situation.nowMs),
    situation.nowMs,
    settings.reconnect_before_window_minutes * 60_000
  );
  if (window) return { kind: "window", reason: describeGuardWindowConflict(window, situation, settings), window };
  const staleness = inverterReadingsStaleness(situation.inverterReadingAgeMs);
  if (staleness) return cause("stale_readings", staleness);
  const socStaleness = socReadingStaleness(situation.socReadingAgeMs);
  if (socStaleness) return cause("stale_soc", socStaleness);
  if (offGridNotApplied(situation, requestedAtMs)) {
    const sinceRequestMs = situation.nowMs - requestedAtMs;
    return cause(
      "not_applied",
      `the DM readback shows ${describeMachineModel(situation.readbackModel)} ${Math.round(sinceRequestMs / 1000)} s after 151 was requested (not applied, or changed since)`
    );
  }
  return undefined;
}

function cause(kind: Exclude<RevertCauseKind, "window">, reason: string): RevertCause {
  return { kind, reason, window: undefined };
}

/** While 151 is requested: the DM readback still doesn't show it past SWITCH_CONFIRM_DEADLINE_MS (or no longer does) */
export function offGridNotApplied(situation: GridOffSituation, requestedAtMs: number): boolean {
  return situation.readbackModel !== OFF_GRID_III_MODEL && situation.nowMs - requestedAtMs > SWITCH_CONFIRM_DEADLINE_MS;
}

/** How long the inverter has read 151 while 050 is wanted, and whether that is past stuck_p1_after_minutes */
export type StuckOffGridTracking = {
  /** Since when 050 is wanted and the inverter reads 151; undefined = not so */
  conditionSinceMs: number | undefined;
  stuck: boolean;
};

export const NOT_STUCK_OFF_GRID: StuckOffGridTracking = { conditionSinceMs: undefined, stuck: false };

/**
 * Stuck: 050 wanted, the inverter still reading 151, for stuck_p1_after_minutes (a DM050 refused or never
 * applied, at startup too). That pages a P1, and from then on nothing treats the relay as open on purpose:
 * buying and the held alerts resume, since the house may well be on the grid's mercy for hours.
 */
export function trackStuckOffGrid(
  previous: StuckOffGridTracking,
  {
    requestedModel,
    readbackModel,
    nowMs,
  }: { requestedModel: MachineModelCode; readbackModel: string | undefined; nowMs: number },
  settings: GridOffConfig
): StuckOffGridTracking {
  if (requestedModel !== NORMAL_HYBRID_MODEL || readbackModel !== OFF_GRID_III_MODEL) return NOT_STUCK_OFF_GRID;
  const conditionSinceMs = previous.conditionSinceMs ?? nowMs;
  return { conditionSinceMs, stuck: nowMs - conditionSinceMs >= settings.stuck_p1_after_minutes * 60_000 };
}

/** DM050s sent (queued) since the inverter started reading 151 while 050 is wanted */
export type SwitchBackSends = { count: number; lastAtMs: number | undefined };

export const NO_SWITCH_BACK_SENDS: SwitchBackSends = { count: 0, lastAtMs: undefined };

/** Is another DM050 due (SWITCH_BACK_RESEND_INTERVALS_MS)? The first one always is */
export function switchBackResendDue(sends: SwitchBackSends, nowMs: number): boolean {
  if (sends.count === 0 || sends.lastAtMs === undefined) return true;
  const intervalIndex = Math.min(sends.count - 1, SWITCH_BACK_RESEND_INTERVALS_MS.length - 1);
  return nowMs - sends.lastAtMs >= SWITCH_BACK_RESEND_INTERVALS_MS[intervalIndex]!;
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
  const soonest = conflictingWindow(
    scheduledWindows(situation.sellSchedule, situation.buySchedule, situation.nowMs),
    situation.nowMs,
    settings.reconnect_before_window_minutes * 60_000
  );
  return soonest && describeGuardWindowConflict(soonest, situation, settings);
}

function describeGuardWindowConflict(
  window: ScheduledWindow,
  situation: Pick<GridOffSituation, "nowMs">,
  settings: GridOffConfig
): string {
  if (window.startMs <= situation.nowMs) return `a ${window.kind} window is active (${window.start} → ${window.end})`;
  const minutesAway = Math.ceil((window.startMs - situation.nowMs) / 60_000);
  return `a ${window.kind} window starts in ${minutesAway} min (${window.start}), within grid_off.reconnect_before_window_minutes ${settings.reconnect_before_window_minutes}`;
}

/** One buy or sell schedule entry with parseable times, under the start key it is written at */
export type ScheduledWindow = { kind: "buy" | "sell"; start: string; end: string; startMs: number; endMs: number };

/**
 * Every buy and sell window that hasn't ended at nowMs, the earliest start first (on a tie the sell one, as
 * the guard always listed them). An entry whose times don't parse is skipped.
 */
export function scheduledWindows(
  sellSchedule: ScheduleWindows,
  buySchedule: ScheduleWindows,
  nowMs: number
): ScheduledWindow[] {
  return [...windowsOf("sell", sellSchedule, nowMs), ...windowsOf("buy", buySchedule, nowMs)].sort(
    (first, second) => first.startMs - second.startMs
  );
}

/** The earliest of these windows that is active at nowMs or starts within leadMs of it, or undefined */
export function conflictingWindow(
  windows: readonly ScheduledWindow[],
  nowMs: number,
  leadMs: number
): ScheduledWindow | undefined {
  return windows.find(window => window.endMs > nowMs && window.startMs - nowMs <= leadMs);
}

function windowsOf(kind: ScheduledWindow["kind"], schedule: ScheduleWindows, nowMs: number): ScheduledWindow[] {
  return Object.entries(schedule).flatMap(([start, entry]) => {
    const startMs = Date.parse(start);
    const endMs = Date.parse(entry.end_time);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= nowMs) return [];
    return [{ kind, start, end: entry.end_time, startMs, endMs }];
  });
}

function inverterReadingsStaleness(ageMs: number | undefined): string | undefined {
  if (ageMs === undefined) return "no inverter readings (GS/PS) yet";
  if (ageMs > FRESH_INVERTER_READING_MAX_AGE_MS) {
    return `the inverter readings (GS/PS) are ${Math.round(ageMs / 1000)} s old (over ${FRESH_INVERTER_READING_MAX_AGE_MS / 1000} s)`;
  }
  return undefined;
}

/**
 * Hall sensor 2 samples several times a second: a minute without one means the ADC or current measuring is
 * down, and the SOC is then only the drain term counting down (~0.15 pp/h against ~1.2 a night off the grid
 * really takes), so the floor would come ~10 pp late. The same guard age as GS/PS.
 */
function socReadingStaleness(ageMs: number | undefined): string | undefined {
  if (ageMs === undefined) return "no battery current reading (hall sensor 2, the SOC's input) yet";
  if (ageMs > FRESH_INVERTER_READING_MAX_AGE_MS) {
    return `the battery current reading (hall sensor 2, the SOC's input) is ${Math.round(ageMs / 1000)} s old (over ${FRESH_INVERTER_READING_MAX_AGE_MS / 1000} s)`;
  }
  return undefined;
}
