import type { AlertingConfig } from "../config/config.types.ts";
import type {
  InverterOperatingStatus,
  InverterWorkingModeCode,
  InverterWorkingModeReading,
} from "../inverterComms/inverterStatus.types.ts";
import type { AlertSeverity } from "./alerting.types.ts";
import type { TimedReading } from "./inverterStuckDetection.ts";
import {
  activeFaultSentence,
  bypassAlert,
  bypassResolvedAlert,
  faultModeAlert,
  faultModeResolvedAlert,
  type GridState,
  type InverterFaultAlert,
  newFaultAlert,
  type NewFaultFacts,
} from "./inverterFaultAlertText.ts";

/**
 * Alerts on what the inverter says about itself (PI17 MOD / CFS / WS, tracked by
 * inverterComms/inverterStatusTracking.ts) — pure: the wiring in inverterFaultAlerts.ts owns the
 * clock, the manager and the episode file; the words are in inverterFaultAlertText.ts.
 *
 * - P1 once Fault mode (MOD 04) has been READ for the configured time since the episode's onset:
 *   with any delay above 0 a single reading never pages, it takes a later one still saying 04.
 *   Quiet P3 once a reading says otherwise.
 * - P2 for a new latest fault code (CFS changed). It waits for a working-mode reading taken after
 *   the change: if that says Fault mode, the P1 carries the code (one push, not two); if the
 *   fault clears before the P1 is due, or the inverter kept running, the P2 goes out. A code that
 *   changes during an already-paged Fault episode gets its own P2 (the page named the old one).
 *   CFS is sticky, so only a change counts, never the first reading ever.
 * - P2 for Bypass mode with the grid present (house straight on the grid, no backup — so far
 *   always a disconnected battery), quiet P3 when it ends.
 *
 * Episodes survive controller restarts (persistableFaultAlerts / restoreFaultAlerts): the first
 * fresh reading after a start adopts a restored episode if it still shows that mode within the
 * alert cooldown of its last reading, and resolves it if the mode changed — a crash loop during a
 * latch pages once, and its "Resolved" still arrives. After a longer downtime it pages again (see
 * advanceEpisode).
 *
 * A reading older than STATUS_READING_MAX_AGE_MS decides nothing: the MOD poll stalling must
 * neither page nor resolve (the "Inverter data stale" alert owns a dead link).
 */
export function stepInverterFaultAlerts(
  previous: InverterFaultAlertState,
  snapshot: InverterFaultSnapshot,
  settings: InverterFaultSettings
): { state: InverterFaultAlertState; alerts: InverterFaultAlert[] } {
  const alerts: InverterFaultAlert[] = [];
  const mode = freshWorkingMode(snapshot);
  const pendingNewFault = detectNewFault(previous, snapshot);
  const faultMode = stepFaultMode(previous.faultMode, mode, snapshot, settings, alerts);
  const bypass = stepBypass(previous.bypass, mode, snapshot, settings, alerts);
  const latestFault = snapshot.status.latest_fault;
  return {
    state: {
      faultMode,
      bypass,
      lastSeenLatestFault: latestFault
        ? { code: latestFault.code, recordId: latestFault.record_id }
        : previous.lastSeenLatestFault,
      pendingNewFault: stepPendingNewFault(pendingNewFault, faultMode, mode, snapshot, settings, alerts),
    },
    alerts,
  };
}

/** Three missed minute-polls: older than that, a reading says nothing about now */
export const STATUS_READING_MAX_AGE_MS = 3 * 60_000;
/** The grid is judged from GS's phase R voltage, which arrives about once a second */
export const GRID_READING_MAX_AGE_MS = 2 * 60_000;
/** A new fault code whose working mode never gets read is reported without it after this long */
export const NEW_FAULT_MODE_WAIT_MS = 3 * 60_000;
/** After a start, the Fault-mode page waits this long at most for the first fault-code reading */
export const FIRST_FAULT_CODE_WAIT_MS = 30_000;

export type InverterFaultSettings = Pick<
  AlertingConfig,
  | "inverter_fault_mode_p1"
  | "inverter_fault_mode_p1_after_seconds"
  | "inverter_fault_code_p2"
  | "inverter_bypass_p2"
  | "inverter_bypass_p2_after_seconds"
  | "grid_out_below_volts"
  | "cooldown_minutes"
>;

export type InverterFaultSnapshot = {
  nowMs: number;
  status: InverterOperatingStatus;
  /** ac_input_voltage_r as the inverter last reported it */
  gridVoltage: TimedReading<number> | undefined;
  /** The stuck-inverter alert's P1 is out for an episode still open: one page per episode is enough */
  stuckP1Open: boolean;
};

export type { InverterFaultAlert } from "./inverterFaultAlertText.ts";

/**
 * Shared by this alert and the stuck-inverter one, which can both page for one latch (Fault mode
 * after ~1.5 min, the inferred stuck P1 — when enabled — half an hour or more later): the second
 * P1 of an episode goes out as a P2. Mutable on purpose: each alert's timer writes its own flag and
 * reads the other's.
 */
export type InverterEpisodePaging = { faultModeP1Open: boolean; stuckP1Open: boolean };

/** One run of Fault or Bypass mode as the alerts track it */
export type ModeEpisode = {
  /** First reading of the run: names the alert keys and is quoted as the onset */
  onsetMs: number;
  /** False when the run was already there at the controller's first reading: "at least since" */
  onsetKnown: boolean;
  /** The tracker's `since` for the run in this controller run; undefined while restored, until read */
  runSinceMs: number | undefined;
  /** The newest reading of the episode's mode (wall clock, like every reading's time) */
  lastReadingAtMs: number;
  /** How the episode's alert went out; undefined until it has */
  alertedSeverity: AlertSeverity | undefined;
  alertedAtMs: number | undefined;
  /** Fault mode only: the latest fault code the page named */
  alertedFaultCode: number | undefined;
};

export type InverterFaultAlertState = {
  faultMode: ModeEpisode | undefined;
  bypass: ModeEpisode | undefined;
  /** CFS code + flash slot as last seen; undefined until the first reading ever */
  lastSeenLatestFault: { code: number; recordId: number } | undefined;
  /** A new latest fault waiting for a working-mode reading taken after it */
  pendingNewFault: NewFaultFacts | undefined;
};

export const INVERTER_FAULT_IDLE_STATE: InverterFaultAlertState = {
  faultMode: undefined,
  bypass: undefined,
  lastSeenLatestFault: undefined,
  pendingNewFault: undefined,
};

/** Whether this policy's P1 is out for a Fault-mode run that is still open (the stuck alert defers to it) */
export function faultModeP1Open(state: InverterFaultAlertState): boolean {
  return state.faultMode?.alertedSeverity === "P1";
}

/**
 * One sentence for the stuck-inverter alert while the inverter itself reports Fault mode, so its
 * P2 names the fault code instead of only inferring a latch from the battery current.
 */
export function describeActiveInverterFault(status: InverterOperatingStatus, nowMs: number): string | undefined {
  const mode = status.working_mode;
  if (!mode || mode.code !== "04" || nowMs - mode.time > STATUS_READING_MAX_AGE_MS) return undefined;
  return activeFaultSentence(mode, status, nowMs);
}

/** What survives a controller restart (inverterFaultEpisodeStore.ts writes it as JSON) */
export type PersistedInverterFaultAlerts = {
  fault_mode: PersistedModeEpisode | null;
  bypass: PersistedModeEpisode | null;
  last_seen_latest_fault: { code: number; record_id: number } | null;
  pending_new_fault: { code: number; text: string; previous_code: number; observed_at_ms: number } | null;
};

export type PersistedModeEpisode = {
  onset_ms: number;
  onset_known: boolean;
  last_reading_at_ms: number;
  alerted_severity: AlertSeverity | null;
  alerted_at_ms: number | null;
  alerted_fault_code: number | null;
};

export function persistableFaultAlerts(state: InverterFaultAlertState): PersistedInverterFaultAlerts {
  const pending = state.pendingNewFault;
  return {
    fault_mode: persistableEpisode(state.faultMode),
    bypass: persistableEpisode(state.bypass),
    last_seen_latest_fault: state.lastSeenLatestFault
      ? { code: state.lastSeenLatestFault.code, record_id: state.lastSeenLatestFault.recordId }
      : null,
    pending_new_fault: pending
      ? {
          code: pending.code,
          text: pending.text,
          previous_code: pending.previousCode,
          observed_at_ms: pending.observedAtMs,
        }
      : null,
  };
}

/**
 * Back from a restart, an open episode waits for its first reading (runSinceMs undefined), and the
 * last CFS seen makes a fault recorded during the downtime count as new.
 */
export function restoreFaultAlerts(persisted: PersistedInverterFaultAlerts | undefined): InverterFaultAlertState {
  if (!persisted) return INVERTER_FAULT_IDLE_STATE;
  const lastSeen = persisted.last_seen_latest_fault;
  const pending = persisted.pending_new_fault;
  return {
    faultMode: restoredEpisode(persisted.fault_mode),
    bypass: restoredEpisode(persisted.bypass),
    lastSeenLatestFault: lastSeen ? { code: lastSeen.code, recordId: lastSeen.record_id } : undefined,
    pendingNewFault: pending
      ? {
          code: pending.code,
          text: pending.text,
          previousCode: pending.previous_code,
          observedAtMs: pending.observed_at_ms,
        }
      : undefined,
  };
}

function freshWorkingMode(snapshot: InverterFaultSnapshot): InverterWorkingModeReading | undefined {
  const mode = snapshot.status.working_mode;
  return mode && snapshot.nowMs - mode.time <= STATUS_READING_MAX_AGE_MS ? mode : undefined;
}

function detectNewFault(previous: InverterFaultAlertState, snapshot: InverterFaultSnapshot): NewFaultFacts | undefined {
  const latestFault = snapshot.status.latest_fault;
  const lastSeen = previous.lastSeenLatestFault;
  if (!latestFault || !lastSeen) return previous.pendingNewFault;
  if (latestFault.code === lastSeen.code && latestFault.record_id === lastSeen.recordId) {
    return previous.pendingNewFault;
  }
  return {
    code: latestFault.code,
    text: latestFault.text,
    previousCode: lastSeen.code,
    observedAtMs: latestFault.since,
  };
}

/**
 * The episode a fresh reading belongs to, and the one it ended (to resolve).
 *
 * A reading continues an episode — the run it has been following, a restored one after a restart,
 * or one that has already alerted, across another mode that came and went between two ticks (too
 * briefly to call it fixed) — only within `continuityMaxGapMs` (the alert cooldown) of the
 * episode's newest reading. Past that the controller was blind for longer than the manager would
 * have suppressed a repeat anyway: a new episode opens (new key, onset "at least since" that
 * reading, a fresh page once the delay holds) and the old one's resolve is implied by it.
 *
 * Both directions count: the pi's clock can be off at boot until NTP steps it. A restored episode
 * adopted on a pre-NTP clock (which reads "just after the shutdown") is split by the step itself,
 * once a later reading lands more than the cooldown after the one before it; a clock still behind
 * by less than that is taken as a short restart.
 */
function advanceEpisode(
  previous: ModeEpisode | undefined,
  mode: InverterWorkingModeReading,
  episodeModeCode: InverterWorkingModeCode,
  continuityMaxGapMs: number
): { episode: ModeEpisode | undefined; ended: ModeEpisode | undefined } {
  if (mode.code !== episodeModeCode) return { episode: undefined, ended: previous };
  const continuesRun = previous?.runSinceMs === mode.since;
  // A run the episode hasn't followed yet starts at its first reading; a followed one at the newest
  const firstUnseenReadingAtMs = continuesRun ? mode.time : mode.since;
  const restored = previous?.runSinceMs === undefined;
  if (previous && (continuesRun || restored || previous.alertedSeverity)) {
    const gapMs = firstUnseenReadingAtMs - previous.lastReadingAtMs;
    // Across a restart a reading older than the last one before it can only be a boot clock that
    // lags (a stale saved clock, NTP not there yet): a short restart, never a long downtime
    if ((restored ? gapMs : Math.abs(gapMs)) <= continuityMaxGapMs) {
      return { episode: { ...previous, runSinceMs: mode.since, lastReadingAtMs: mode.time }, ended: undefined };
    }
    return { episode: newEpisode(mode, firstUnseenReadingAtMs, false), ended: undefined };
  }
  return { episode: newEpisode(mode, mode.since, mode.since_is_onset), ended: undefined };
}

function newEpisode(mode: InverterWorkingModeReading, onsetMs: number, onsetKnown: boolean): ModeEpisode {
  return {
    onsetMs,
    onsetKnown,
    runSinceMs: mode.since,
    lastReadingAtMs: mode.time,
    alertedSeverity: undefined,
    alertedAtMs: undefined,
    alertedFaultCode: undefined,
  };
}

function stepFaultMode(
  previous: ModeEpisode | undefined,
  mode: InverterWorkingModeReading | undefined,
  snapshot: InverterFaultSnapshot,
  settings: InverterFaultSettings,
  alerts: InverterFaultAlert[]
): ModeEpisode | undefined {
  if (!mode) return previous;
  const { episode, ended } = advanceEpisode(previous, mode, "04", continuityWindowMs(settings));
  if (ended?.alertedSeverity) {
    alerts.push(faultModeResolvedAlert(ended, mode, snapshot.status, snapshot.nowMs, clearedUnseen(ended)));
  }
  if (!episode || episode.alertedSeverity || !settings.inverter_fault_mode_p1) return episode;
  if (mode.time - episode.onsetMs < settings.inverter_fault_mode_p1_after_seconds * 1000) return episode;
  // The page names the fault code: right after a start, give the first CFS (it rides in the same
  // round as the first MOD) a moment rather than paging "not read yet" and then a P2 for the code
  if (!snapshot.status.latest_fault && snapshot.nowMs - mode.since < FIRST_FAULT_CODE_WAIT_MS) return episode;
  const severity = snapshot.stuckP1Open ? "P2" : "P1";
  alerts.push(faultModeAlert(episode, severity, gridState(snapshot, settings), snapshot.status, snapshot.nowMs));
  return {
    ...episode,
    alertedSeverity: severity,
    alertedAtMs: snapshot.nowMs,
    alertedFaultCode: snapshot.status.latest_fault?.code,
  };
}

function stepPendingNewFault(
  pending: NewFaultFacts | undefined,
  faultMode: ModeEpisode | undefined,
  mode: InverterWorkingModeReading | undefined,
  snapshot: InverterFaultSnapshot,
  settings: InverterFaultSettings,
  alerts: InverterFaultAlert[]
): NewFaultFacts | undefined {
  if (!pending || !settings.inverter_fault_code_p2) return undefined;
  if (faultMode?.alertedSeverity && faultMode.alertedAtMs !== undefined) {
    // The Fault-mode page named this code already; a different one came during the episode
    if (pending.code === faultMode.alertedFaultCode) return undefined;
    const pagedEpisode = { ...faultMode, alertedAtMs: faultMode.alertedAtMs };
    alerts.push(newFaultAlert(pending, undefined, pagedEpisode, snapshot.status, snapshot.nowMs));
    return undefined;
  }
  const modeReadAfterChange = mode && mode.time >= pending.observedAtMs ? mode : undefined;
  const waitingForTheP1 = modeReadAfterChange?.code === "04" && settings.inverter_fault_mode_p1;
  if (waitingForTheP1) return pending;
  if (!modeReadAfterChange && snapshot.nowMs - pending.observedAtMs < NEW_FAULT_MODE_WAIT_MS) return pending;
  alerts.push(newFaultAlert(pending, modeReadAfterChange, undefined, snapshot.status, snapshot.nowMs));
  return undefined;
}

function stepBypass(
  previous: ModeEpisode | undefined,
  mode: InverterWorkingModeReading | undefined,
  snapshot: InverterFaultSnapshot,
  settings: InverterFaultSettings,
  alerts: InverterFaultAlert[]
): ModeEpisode | undefined {
  if (!mode) return previous;
  const { episode, ended } = advanceEpisode(previous, mode, "02", continuityWindowMs(settings));
  if (ended?.alertedSeverity) alerts.push(bypassResolvedAlert(ended, mode, snapshot.nowMs, clearedUnseen(ended)));
  if (!episode || episode.alertedSeverity || !settings.inverter_bypass_p2) return episode;
  if (mode.time - episode.onsetMs < settings.inverter_bypass_p2_after_seconds * 1000) return episode;
  // Without the grid, Bypass leaves the house dark — the grid-out alert already says that
  const gridVoltage = snapshot.gridVoltage;
  if (gridState(snapshot, settings) !== "present" || !gridVoltage) return episode;
  alerts.push(bypassAlert(episode, gridVoltage.value, snapshot.status, snapshot.nowMs));
  return { ...episode, alertedSeverity: "P2", alertedAtMs: snapshot.nowMs };
}

/**
 * How long a gap between readings still continues an episode: the alert cooldown (a longer
 * blind spot would have re-paged anyway), but never less than a gap the policy still acts on —
 * at a 0 or 1 min cooldown every minute's reading would otherwise open a new episode and the
 * 60 s delay could never elapse.
 */
function continuityWindowMs(settings: InverterFaultSettings): number {
  return Math.max(settings.cooldown_minutes * 60_000, STATUS_READING_MAX_AGE_MS);
}

/** A restored episode no reading ever adopted ended while the controller was down: when exactly is unknown */
function clearedUnseen(ended: ModeEpisode): boolean {
  return ended.runSinceMs === undefined;
}

function gridState(snapshot: InverterFaultSnapshot, settings: InverterFaultSettings): GridState {
  const gridVoltage = snapshot.gridVoltage;
  if (!gridVoltage || snapshot.nowMs - gridVoltage.time > GRID_READING_MAX_AGE_MS) return "unknown";
  return gridVoltage.value >= settings.grid_out_below_volts ? "present" : "out";
}

function persistableEpisode(episode: ModeEpisode | undefined): PersistedModeEpisode | null {
  if (!episode) return null;
  return {
    onset_ms: episode.onsetMs,
    onset_known: episode.onsetKnown,
    last_reading_at_ms: episode.lastReadingAtMs,
    alerted_severity: episode.alertedSeverity ?? null,
    alerted_at_ms: episode.alertedAtMs ?? null,
    alerted_fault_code: episode.alertedFaultCode ?? null,
  };
}

function restoredEpisode(persisted: PersistedModeEpisode | null): ModeEpisode | undefined {
  if (!persisted) return undefined;
  return {
    onsetMs: persisted.onset_ms,
    onsetKnown: persisted.onset_known,
    lastReadingAtMs: persisted.last_reading_at_ms,
    runSinceMs: undefined,
    alertedSeverity: persisted.alerted_severity ?? undefined,
    alertedAtMs: persisted.alerted_at_ms ?? undefined,
    alertedFaultCode: persisted.alerted_fault_code ?? undefined,
  };
}
