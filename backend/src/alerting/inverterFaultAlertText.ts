/**
 * The words of the inverter fault alerts (inverterFaultAlertPolicy.ts decides when) — pure. They
 * are read half-asleep at 04:15, so they say what is wrong, what it means for the house, and what
 * to do, and leave out the warning flags this inverter sets every night anyway.
 */
import type { InverterOperatingStatus, InverterWorkingModeReading } from "../inverterComms/inverterStatus.types.ts";
import { describeInverterFaultCode } from "../inverterComms/inverterFaultCodes.ts";
import { WARNING_FLAGS_SET_EVERY_NIGHT } from "../inverterComms/pi17FieldTables.ts";
import type { AlertSeverity } from "./alerting.types.ts";
import { INVERTER_POWER_CYCLE_PROCEDURE } from "./alertingLogic.ts";
import { formatStockholmTime } from "./inverterStuckAlertPolicy.ts";

export type InverterFaultAlert = { key: string; severity: AlertSeverity; title: string; message: string };

/** Whether the grid is there, as judged from a fresh phase-R reading */
export type GridState = "present" | "out" | "unknown";

/** The facts about one Fault/Bypass episode the texts quote */
export type EpisodeFacts = {
  onsetMs: number;
  /** False when the controller only saw it from its first reading after a start: "at least since" */
  onsetKnown: boolean;
};

export function faultModeAlert(
  episode: EpisodeFacts,
  severity: AlertSeverity,
  grid: GridState,
  status: InverterOperatingStatus,
  nowMs: number
): InverterFaultAlert {
  const latestFault = status.latest_fault;
  const downgradeNote =
    severity === "P1" ? "" : " (Sent as P2: the stuck-inverter alert already paged for this episode.)";
  return {
    key: faultModeKey(episode.onsetMs),
    severity,
    title: latestFault ? `Inverter in Fault mode: F${twoDigits(latestFault.code)}` : "Inverter in Fault mode",
    message:
      `The inverter has been in Fault mode ${describeSince(episode, nowMs)}, ${latestFaultPhrase(status)}. ` +
      `${consequenceOfFaultMode(grid)} ${INVERTER_POWER_CYCLE_PROCEDURE}` +
      warningsSentence(status) +
      downgradeNote,
  };
}

/** `clearedUnseen`: it ended while the controller was down, at some point the texts can only bound */
export function faultModeResolvedAlert(
  episode: EpisodeFacts,
  mode: InverterWorkingModeReading,
  status: InverterOperatingStatus,
  nowMs: number,
  clearedUnseen: boolean
): InverterFaultAlert {
  return {
    key: `${faultModeKey(episode.onsetMs)}:resolved`,
    severity: "P3",
    title: "Resolved: Inverter in Fault mode",
    message: `The inverter left Fault mode for ${mode.text} ${describeDuration(episode, mode.time, clearedUnseen)} (in Fault mode ${describeSince(episode, nowMs)}; ${latestFaultPhrase(status)}).`,
  };
}

export type NewFaultFacts = { code: number; text: string; previousCode: number; observedAtMs: number };

/**
 * `modeReadAfterChange`: a fresh working-mode reading taken after the code changed, if any.
 * `pagedEpisode`: the Fault-mode episode whose page named an older code, when the new one came
 * during it.
 */
export function newFaultAlert(
  newFault: NewFaultFacts,
  modeReadAfterChange: InverterWorkingModeReading | undefined,
  pagedEpisode: (EpisodeFacts & { alertedAtMs: number; alertedFaultCode: number | undefined }) | undefined,
  status: InverterOperatingStatus,
  nowMs: number
): InverterFaultAlert {
  return {
    key: `inverter-fault-code:${newFault.observedAtMs}`,
    severity: "P2",
    title: `Inverter recorded fault F${twoDigits(newFault.code)}`,
    message:
      `The inverter recorded a new fault by ${formatStockholmTime(newFault.observedAtMs, nowMs)} (local time): ${newFault.text} ` +
      `(the one before: ${describeInverterFaultCode(newFault.previousCode)}). ` +
      describeModeAfterNewFault(newFault, modeReadAfterChange, pagedEpisode, status, nowMs) +
      warningsSentence(status),
  };
}

export function bypassAlert(
  episode: EpisodeFacts,
  gridVolts: number,
  status: InverterOperatingStatus,
  nowMs: number
): InverterFaultAlert {
  const batteryNote = status.warnings?.active.includes("Battery disconnected")
    ? " The inverter also warns the battery is disconnected: check the battery breaker and the BMS."
    : "";
  return {
    key: bypassKey(episode.onsetMs),
    severity: "P2",
    title: "Inverter in Bypass mode",
    message:
      `The inverter has been in Bypass mode ${describeSince(episode, nowMs)} with the grid at ${Math.round(gridVolts)} V: ` +
      `the house runs straight off the grid, with the battery and PV unused and no backup. Every Bypass so far was a disconnected battery.` +
      (batteryNote || warningsSentence(status)),
  };
}

export function bypassResolvedAlert(
  episode: EpisodeFacts,
  mode: InverterWorkingModeReading,
  nowMs: number,
  clearedUnseen: boolean
): InverterFaultAlert {
  return {
    key: `${bypassKey(episode.onsetMs)}:resolved`,
    severity: "P3",
    title: "Resolved: Inverter in Bypass mode",
    message: `The inverter left Bypass mode for ${mode.text} ${describeDuration(episode, mode.time, clearedUnseen)} (Bypass ${describeSince(episode, nowMs)}).`,
  };
}

/** One sentence for the stuck-inverter alert while the inverter itself reports Fault mode */
export function activeFaultSentence(
  mode: InverterWorkingModeReading,
  status: InverterOperatingStatus,
  nowMs: number
): string {
  const since = describeSince({ onsetMs: mode.since, onsetKnown: mode.since_is_onset }, nowMs);
  return `The inverter itself reports Fault mode ${since}, ${latestFaultPhrase(status)}.`;
}

/**
 * Per episode, like the stuck alert's keys: a re-latch minutes after a "Resolved" must not land in
 * the previous page's per-key cooldown. The episode survives controller restarts
 * (inverterFaultEpisodeStore.ts), so its key does too and a restart doesn't page again.
 */
function faultModeKey(onsetMs: number): string {
  return `inverter-fault-mode:${onsetMs}`;
}

function bypassKey(onsetMs: number): string {
  return `inverter-bypass:${onsetMs}`;
}

function consequenceOfFaultMode(grid: GridState): string {
  if (grid === "present") return "Battery and PV are off; the house runs on the grid with no backup.";
  if (grid === "out") return "Battery and PV are off and the grid is down: the house has no power.";
  return "Battery and PV are off: no backup.";
}

function describeModeAfterNewFault(
  newFault: NewFaultFacts,
  modeReadAfterChange: InverterWorkingModeReading | undefined,
  pagedEpisode: (EpisodeFacts & { alertedAtMs: number; alertedFaultCode: number | undefined }) | undefined,
  status: InverterOperatingStatus,
  nowMs: number
): string {
  if (pagedEpisode) {
    const pagedFor =
      pagedEpisode.alertedFaultCode === undefined ? "" : ` for F${twoDigits(pagedEpisode.alertedFaultCode)}`;
    return `It came while the inverter is still in Fault mode, paged at ${formatStockholmTime(pagedEpisode.alertedAtMs, nowMs)}${pagedFor}.`;
  }
  if (modeReadAfterChange?.code === "04") return `It is in Fault mode: ${INVERTER_POWER_CYCLE_PROCEDURE}`;
  if (modeReadAfterChange) {
    return `It is in ${modeReadAfterChange.text} now, so it is running (it may have recovered by itself).`;
  }
  const lastMode = status.working_mode;
  if (lastMode && lastMode.time >= newFault.observedAtMs) {
    return `Its working mode was last read at ${formatStockholmTime(lastMode.time, nowMs)}, as ${lastMode.text}.`;
  }
  return "Its working mode hasn't been read since.";
}

function describeSince(episode: EpisodeFacts, nowMs: number): string {
  return `${episode.onsetKnown ? "since" : "at least since"} ${formatStockholmTime(episode.onsetMs, nowMs)} (local time)`;
}

function describeDuration(episode: EpisodeFacts, untilMs: number, clearedUnseen: boolean): string {
  const duration = formatMinutes(untilMs - episode.onsetMs);
  if (clearedUnseen) return `within ${duration}, while the controller was down`;
  return `after ${episode.onsetKnown ? "" : "at least "}${duration}`;
}

function latestFaultPhrase(status: InverterOperatingStatus): string {
  return status.latest_fault ? `latest recorded fault ${status.latest_fault.text}` : "fault code not read yet";
}

function warningsSentence(status: InverterOperatingStatus): string {
  const meaningfulFlags = (status.warnings?.active ?? []).filter(flag => !WARNING_FLAGS_SET_EVERY_NIGHT.has(flag));
  return meaningfulFlags.length ? ` Inverter warnings: ${meaningfulFlags.join(", ")}.` : "";
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

function formatMinutes(durationMs: number): string {
  const minutes = Math.round(durationMs / 60_000);
  return minutes < 120 ? `${minutes} min` : `${(minutes / 60).toFixed(1)} h`;
}
