/**
 * One log line per inverter status event — pure, so the selftest pins the wording. Nothing here
 * is an errorLog: that would forward as a P2 on top of the fault alerts in
 * alerting/inverterFaultAlerts.ts, which own the paging. Entering a mode the inverter can't
 * deliver backup in, or a new fault code, is a warning; everything else is information.
 */
import type { InverterWorkingModeCode } from "./inverterStatus.types.ts";
import type { InverterStatusEvent } from "./inverterStatusTracking.ts";
import { describeFaultRecordValues } from "./inverterFaultRecordText.ts";

export function describeInverterStatusEvent(event: InverterStatusEvent): {
  level: "log" | "warn" | "debug";
  text: string;
} {
  if (event.kind === "working_mode_changed") {
    const current = `${event.current.text} (${event.current.code})`;
    const level = MODES_WITHOUT_BACKUP.has(event.current.code) ? "warn" : "log";
    if (!event.previous) return { level, text: `Inverter working mode: ${current}` };
    const heldFor = formatDuration(event.current.time - event.previous.since);
    return {
      level,
      text: `Inverter working mode changed: ${event.previous.text} (${event.previous.code}) → ${current}, after ${heldFor} in the previous mode`,
    };
  }
  if (event.kind === "latest_fault_changed") {
    const current = `${event.current.text} (flash slot ${formatSlot(event.current.record_id)})`;
    if (!event.previous) {
      return {
        level: "log",
        text: `Inverter's latest recorded fault (CFS, sticky — not necessarily active): ${current}`,
      };
    }
    return {
      level: "warn",
      text: `Inverter recorded a new fault: ${current}; before it: ${event.previous.text} (flash slot ${formatSlot(event.previous.record_id)}). Reading the working mode and the fault records.`,
    };
  }
  if (event.kind === "warnings_changed") {
    const active = event.active.length ? event.active.join(", ") : "none";
    if (!event.previouslyActive) return { level: "log", text: `Inverter warning flags: ${active}` };
    const raised = event.active.filter(name => !event.previouslyActive?.includes(name));
    const cleared = event.previouslyActive.filter(name => !event.active.includes(name));
    const changes = [
      raised.length ? `raised ${raised.join(", ")}` : undefined,
      cleared.length ? `cleared ${cleared.join(", ")}` : undefined,
    ].filter(change => change !== undefined);
    return { level: "log", text: `Inverter warning flags ${changes.join("; ")} — now active: ${active}` };
  }
  if (event.kind === "fault_record_read") {
    const record = event.record;
    return {
      level: "log",
      text:
        `Inverter fault record slot ${formatSlot(record.record_id)}${event.changedSinceLastRead ? " (changed since the last read)" : ""}: ` +
        `${record.fault_text} — at the fault: ${record.values ? describeFaultRecordValues(record.values) : "values unreadable"}; ` +
        `unidentified tokens ${record.unidentified}`,
    };
  }
  if (event.kind === "dc_idle_reported") {
    return {
      level: "debug",
      text: "Inverter reports its DC side idle (0 A, battery and DC/AC Idle) — reading the working mode now",
    };
  }
  return {
    level: "warn",
    text: `Unreadable inverter ${event.command} round dropped from status tracking: ${event.detail}`,
  };
}

/** Power on, standby, bypass and fault: battery and PV aren't carrying the house in any of them */
const MODES_WITHOUT_BACKUP: ReadonlySet<InverterWorkingModeCode> = new Set(["00", "01", "02", "04"]);

function formatSlot(recordId: number): string {
  return String(recordId).padStart(2, "0");
}

function formatDuration(durationMs: number): string {
  const totalMinutes = Math.round(durationMs / 60_000);
  if (totalMinutes < 1) return `${Math.max(0, Math.round(durationMs / 1000))} s`;
  if (totalMinutes < 120) return `${totalMinutes} min`;
  return `${Math.floor(totalMinutes / 60)} h ${totalMinutes % 60} min`;
}
