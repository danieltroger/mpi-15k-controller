/**
 * What automatic grid-off wants, as pure functions of one snapshot (no I/O, no clock): Off-Grid III (151)
 * unless a rule keeps the inverter on the grid (050), and the next switch the schedule makes known. The
 * rules (grid_off.auto_*):
 * - a sell, buy or hold window is active or starts within reconnect_before_window_minutes (the guard's own test);
 * - the battery is full: on the grid from auto_full_soc_percent so the PV can export, off again only below
 *   auto_resume_soc_percent;
 * - the battery is low: on the grid below min_soc_percent, off again only from min + switch_on_soc_margin_percent;
 * - switching off would leave less than auto_min_off_minutes before the next window's reconnect (the schedule
 *   as it stands, no SOC prediction);
 * - the energy-distribution enforcement is still restoring the 050 profile (a DM change resets HECS, and
 *   switching again before it lands compounds the reset);
 * - a switch-off that didn't hold (NAKed, never read back, reverted for stale readings or an unknown SOC)
 *   holds the retries back;
 * - and whatever else the switch would refuse 151 for (DM readback, stale readings, the rate limit).
 * Off the grid, only the window, full, low and unknown-SOC rules switch back; the switch's guards do the rest.
 * The wiring is useAutoGridOff.ts.
 */
import type { GridOffConfig } from "../config/config.types.ts";
import { NORMAL_HYBRID_MODEL, OFF_GRID_III_MODEL } from "../inverterComms/machineModel.ts";
import { formatStockholmTime } from "../utilities/stockholmDate.ts";
import { conflictingWindow, type ScheduledWindow } from "./gridOffDecisions.ts";
import type { AutoGridOffNextSwitch, AutoGridOffReasonKind } from "./gridOff.types.ts";
import type { MachineModelCode } from "../inverterComms/pi17Protocol.types.ts";

/**
 * After a switch-off that didn't hold, automatic grid-off waits this long before the next try: 5 min after the
 * first, 15 after the second, then hourly until a routine switch back (a window, the battery) clears the count.
 * Each try is a settings write and, back on 050, the HECS restore's: a firmware that refuses 151, or a link that
 * drops every few minutes, would otherwise take them every min_seconds_between_switches. A guard (EEPROM wear),
 * not a knob.
 */
export const AUTO_SWITCH_OFF_RETRY_INTERVALS_MS: readonly number[] = [5 * 60_000, 15 * 60_000, 60 * 60_000];

/** Switches to 151 that didn't hold since the last routine switch back (the switch counts them, gridOffActions.ts) */
export type OffGridFailures = { count: number; lastAtMs: number | undefined };

export const NO_OFF_GRID_FAILURES: OffGridFailures = { count: 0, lastAtMs: undefined };

export type AutoGridOffSituation = {
  nowMs: number;
  /** THE SOC; undefined = unknown */
  soc: number | undefined;
  /** The switch requests 151, whoever asked for it */
  offGridRequested: boolean;
  /** Every buy and sell window that hasn't ended, the earliest first (gridOffDecisions.ts' scheduledWindows) */
  windows: readonly ScheduledWindow[];
  /** Why the switch would refuse 151 now (switchOffGridRefusal); undefined = it would go out */
  switchRefusal: string | undefined;
  /** The energy-distribution enforcement has an open divergence episode on the 050 profile */
  energySettingsRestoring: boolean;
  /** Until when a switch-off that didn't hold holds the next try back (autoRetryBlockedUntilMs); undefined = no hold */
  retryBlockedUntilMs: number | undefined;
};

export type AutoGridOffDecision = { model: MachineModelCode; kind: AutoGridOffReasonKind; reason: string };

/** Main: 151 or 050, and why. The settings are the corrected grid_off section (full > resume holds). */
export function autoGridOffDecision(situation: AutoGridOffSituation, settings: GridOffConfig): AutoGridOffDecision {
  const { nowMs, soc } = situation;
  if (soc === undefined) return onGrid("soc_unknown", "the SOC is unknown");
  const conflict = conflictingWindow(situation.windows, nowMs, settings.reconnect_before_window_minutes * 60_000);
  if (conflict) return onGrid("window", describeWindowConflict(conflict, nowMs, settings));
  // Floored, so the figures read true against their thresholds (94.6 % isn't "95 % ≥ 95 %") and move rarely
  const shownSoc = Math.floor(soc);
  if (soc >= settings.auto_full_soc_percent) {
    return onGrid(
      "battery_full",
      `battery ${shownSoc} % ≥ ${settings.auto_full_soc_percent} % (auto_full_soc_percent), so the PV can export`
    );
  }
  if (situation.offGridRequested) {
    if (soc < settings.min_soc_percent) {
      return onGrid("battery_low", `battery ${shownSoc} % < ${settings.min_soc_percent} % (min_soc_percent)`);
    }
    return offGrid(shownSoc, settings);
  }
  if (soc >= settings.auto_resume_soc_percent) {
    return onGrid(
      "battery_above_resume",
      `battery ${shownSoc} %: off the grid again below ${settings.auto_resume_soc_percent} % (auto_resume_soc_percent)`
    );
  }
  const switchOnSocPercent = settings.min_soc_percent + settings.switch_on_soc_margin_percent;
  if (soc < switchOnSocPercent) {
    return onGrid(
      "battery_low",
      `battery ${shownSoc} % < ${switchOnSocPercent} % (min_soc_percent ${settings.min_soc_percent} + switch_on_soc_margin_percent ${settings.switch_on_soc_margin_percent})`
    );
  }
  const shortStretch = shortStretchReason(situation, settings);
  if (shortStretch) return onGrid("short_stretch", shortStretch);
  if (situation.energySettingsRestoring) {
    return onGrid(
      "energy_settings",
      "the inverter's energy settings (HECS) differ from the 050 profile and are being written back"
    );
  }
  if (situation.retryBlockedUntilMs !== undefined && nowMs < situation.retryBlockedUntilMs) {
    return onGrid(
      "retry_backoff",
      `the last switch to 151 was reverted; the next try is at ${formatStockholmTime(situation.retryBlockedUntilMs, nowMs)}`
    );
  }
  if (situation.switchRefusal) return onGrid("switch_refused", situation.switchRefusal);
  return offGrid(shownSoc, settings);
}

/**
 * The next switch the schedule makes known, or undefined: off the grid, the reconnect for the next window;
 * on the grid for a window or a short stretch, the first moment after it that leaves auto_min_off_minutes
 * (if the battery is in the band then); held back after a failure, the next try. On the grid for the SOC (or
 * a refusal), when it changes isn't known.
 */
export function expectedNextSwitch(
  decision: AutoGridOffDecision,
  situation: Pick<AutoGridOffSituation, "nowMs" | "windows" | "retryBlockedUntilMs">,
  settings: GridOffConfig
): AutoGridOffNextSwitch | undefined {
  const { nowMs, windows } = situation;
  const leadMs = settings.reconnect_before_window_minutes * 60_000;
  if (decision.model === OFF_GRID_III_MODEL) {
    const nextWindow = windows.find(window => window.startMs > nowMs);
    if (!nextWindow) return undefined;
    return {
      model: NORMAL_HYBRID_MODEL,
      at: nextWindow.startMs - leadMs,
      why: `the ${nextWindow.kind} window at ${formatStockholmTime(nextWindow.startMs, nowMs)}`,
    };
  }
  if (decision.kind === "window" || decision.kind === "short_stretch") {
    const opportunity = nextOffGridOpportunity(windows, nowMs, leadMs, settings.auto_min_off_minutes * 60_000);
    if (!opportunity) return undefined;
    const after = opportunity.afterWindow
      ? `after the ${opportunity.afterWindow.kind} window ending at ${formatStockholmTime(opportunity.afterWindow.endMs, nowMs)}`
      : "with the schedule as it stands";
    return { model: OFF_GRID_III_MODEL, at: opportunity.atMs, why: `${after}, if the battery allows` };
  }
  if (decision.kind === "retry_backoff" && situation.retryBlockedUntilMs !== undefined) {
    return {
      model: OFF_GRID_III_MODEL,
      at: situation.retryBlockedUntilMs,
      why: "the next try after a reverted switch",
    };
  }
  return undefined;
}

/**
 * The earliest moment from nowMs on when the windows let automatic grid-off switch off: no window active, and
 * the next one's reconnect at least minOffMs away. Only a window's end can make that true again (between
 * ends the stretch to the next reconnect only shrinks), so nowMs and the ends are the candidates. undefined =
 * never (only with no window ever ending, i.e. not with a finite schedule).
 */
export function nextOffGridOpportunity(
  windows: readonly ScheduledWindow[],
  nowMs: number,
  leadMs: number,
  minOffMs: number
): { atMs: number; afterWindow: ScheduledWindow | undefined } | undefined {
  const candidates: { atMs: number; afterWindow: ScheduledWindow | undefined }[] = [
    { atMs: nowMs, afterWindow: undefined },
    ...windows
      .filter(window => window.endMs > nowMs)
      .map(window => ({ atMs: window.endMs, afterWindow: window }))
      .sort((earlier, later) => earlier.atMs - later.atMs),
  ];
  return candidates.find(({ atMs }) => {
    if (windows.some(window => window.startMs <= atMs && window.endMs > atMs)) return false;
    const nextStartMs = windows.find(window => window.startMs > atMs)?.startMs;
    return nextStartMs === undefined || nextStartMs - leadMs - atMs >= minOffMs;
  });
}

/** Until when the next switch-off waits after ones that didn't hold, or undefined when none since the last routine switch back */
export function autoRetryBlockedUntilMs(failures: OffGridFailures): number | undefined {
  if (failures.count === 0 || failures.lastAtMs === undefined) return undefined;
  const intervalIndex = Math.min(failures.count - 1, AUTO_SWITCH_OFF_RETRY_INTERVALS_MS.length - 1);
  return failures.lastAtMs + AUTO_SWITCH_OFF_RETRY_INTERVALS_MS[intervalIndex]!;
}

/** Switching off now would leave less than auto_min_off_minutes before the next window's reconnect: why */
function shortStretchReason(situation: AutoGridOffSituation, settings: GridOffConfig): string | undefined {
  const nextWindow = situation.windows.find(window => window.startMs > situation.nowMs);
  if (!nextWindow) return undefined;
  const reconnectAtMs = nextWindow.startMs - settings.reconnect_before_window_minutes * 60_000;
  const stretchMinutes = (reconnectAtMs - situation.nowMs) / 60_000;
  if (stretchMinutes >= settings.auto_min_off_minutes) return undefined;
  const windowAt = formatStockholmTime(nextWindow.startMs, situation.nowMs);
  return `only ${Math.floor(stretchMinutes)} min off the grid before the reconnect for the ${nextWindow.kind} window at ${windowAt} (auto_min_off_minutes ${settings.auto_min_off_minutes})`;
}

/**
 * A window active or within the lead, in local time: the reason automatic grid-off gives, and the guard too when
 * it makes that routine reconnect first while automatic grid-off is on (gridOffActions.ts)
 */
export function describeWindowConflict(window: ScheduledWindow, nowMs: number, settings: GridOffConfig): string {
  const startAt = formatStockholmTime(window.startMs, nowMs);
  if (window.startMs <= nowMs) {
    return `a ${window.kind} window is on (${startAt} → ${formatStockholmTime(window.endMs, nowMs)})`;
  }
  return `a ${window.kind} window at ${startAt} starts within ${settings.reconnect_before_window_minutes} min (reconnect_before_window_minutes)`;
}

function onGrid(kind: Exclude<AutoGridOffReasonKind, "off_grid">, reason: string): AutoGridOffDecision {
  return { model: NORMAL_HYBRID_MODEL, kind, reason };
}

function offGrid(shownSoc: number, settings: GridOffConfig): AutoGridOffDecision {
  return {
    model: OFF_GRID_III_MODEL,
    kind: "off_grid",
    reason: `battery ${shownSoc} %: back on the grid below ${settings.min_soc_percent} %, at ${settings.auto_full_soc_percent} % or ${settings.reconnect_before_window_minutes} min before a window`,
  };
}
