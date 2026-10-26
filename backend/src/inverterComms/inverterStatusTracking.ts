/**
 * The inverter's operating status from decoded MOD / CFS / WS / HFS rounds — pure state +
 * transitions, so the selftest and the pty end-to-end test drive exactly what the controller runs.
 * Each step reports what changed (for the log) and which status queries are worth reading right
 * away, closing the loop with statusPollPlan.ts:
 *
 * - working mode changed → CFS + WS: the alert that fires on Fault mode names the fault code, and
 *   the periodic CFS may be up to a minute older than the fault;
 * - latest fault changed → MOD + every fault record: a new fault is either active (MOD says) or
 *   already over, and its flash record holds the value snapshot from the moment it tripped;
 * - the DC side reported idle (#51's latch signature: 0 A, battery and DC/AC both Idle) → MOD at
 *   once, instead of up to a minute later. On 2026-10-21 that picture appeared within ~6 s of the
 *   buy window ending; a legitimate low-voltage cut-off shows it too, hence the rate limit.
 *
 * The first reading of each value after startup is a baseline, not a change: the fault records
 * are read at startup anyway (statusPollPlan.ts), and nothing must page because the controller
 * restarted.
 */
import type { DecodedFields, DecodedRound } from "./pi17Protocol.types.ts";
import type {
  InverterFaultRecord,
  InverterLatestFaultReading,
  InverterOperatingStatus,
  InverterStatusQuery,
  InverterWorkingModeCode,
  InverterWorkingModeReading,
} from "./inverterStatus.types.ts";
import { influxFieldName, PI17_QUERY_RESPONSE_FIELDS, WORKING_MODE_TEXT_BY_CODE } from "./pi17FieldTables.ts";
import { describeInverterFaultCode } from "./inverterFaultCodes.ts";
import { ALL_FAULT_RECORD_QUERIES } from "./statusPollPlan.ts";

export function afterDecodedRound(previous: InverterStatusTracking, round: DecodedRound): StatusTrackingStep {
  if (round.command === "MOD") return afterWorkingModeReading(previous, round);
  if (round.command === "CFS") return afterLatestFaultReading(previous, round);
  if (round.command === "WS") return afterWarningsReading(previous, round);
  if (round.command === "HFS") return afterFaultRecordReading(previous, round);
  if (round.command === "GS" || round.command === "PS") return afterTelemetryReading(previous, round);
  return { tracking: previous, events: [], requestedQueries: [] };
}

/** At most one MOD read per this long on account of the DC-idle signature (a cut-off can flap it) */
export const DC_IDLE_MODE_REQUEST_MIN_INTERVAL_MS = 30_000;

export type InverterStatusTracking = {
  status: InverterOperatingStatus;
  /** GS half of the DC-idle signature: battery_current exactly 0 A */
  batteryCurrentIsZero: boolean | undefined;
  /** PS half: battery and DC/AC power directions both Idle */
  powerDirectionsIdle: boolean | undefined;
  dcIdleReported: boolean;
  /** decodedAt of the round that last asked for MOD because of the DC-idle signature */
  lastDcIdleModeRequestAt: number | undefined;
};

export type InverterStatusEvent =
  | {
      kind: "working_mode_changed";
      previous: InverterWorkingModeReading | undefined;
      current: InverterWorkingModeReading;
    }
  | {
      kind: "latest_fault_changed";
      previous: InverterLatestFaultReading | undefined;
      current: InverterLatestFaultReading;
    }
  /** `previouslyActive` undefined: the first reading since startup */
  | { kind: "warnings_changed"; previouslyActive: string[] | undefined; active: string[] }
  /** Only when the slot's content differs from what was last read from it (or on its first read) */
  | { kind: "fault_record_read"; record: InverterFaultRecord; changedSinceLastRead: boolean }
  | { kind: "dc_idle_reported" }
  /** Can't happen behind the plausibility gate — which is exactly why it is reported */
  | { kind: "unreadable_round"; command: string; detail: string };

export type StatusTrackingStep = {
  tracking: InverterStatusTracking;
  events: InverterStatusEvent[];
  requestedQueries: InverterStatusQuery[];
};

export const INITIAL_INVERTER_STATUS: InverterOperatingStatus = {
  working_mode: undefined,
  latest_fault: undefined,
  warnings: undefined,
  fault_records: [],
};

export const INITIAL_INVERTER_STATUS_TRACKING: InverterStatusTracking = {
  status: INITIAL_INVERTER_STATUS,
  batteryCurrentIsZero: undefined,
  powerDirectionsIdle: undefined,
  dcIdleReported: false,
  lastDcIdleModeRequestAt: undefined,
};

/** The WS flags in protocol order: decoded key → the human-readable name logs and alerts show */
const WARNING_FLAG_NAMES: readonly { key: string; name: string }[] = PI17_QUERY_RESPONSE_FIELDS.WS.map(spec => ({
  key: influxFieldName(spec.name),
  name: spec.name,
}));

/** The HFS snapshot tokens after id, code, time and work mode, in protocol order */
const FAULT_RECORD_SNAPSHOT_KEYS: readonly string[] = PI17_QUERY_RESPONSE_FIELDS.HFS.slice(4).map(spec =>
  influxFieldName(spec.name)
);

function afterWorkingModeReading(previous: InverterStatusTracking, round: DecodedRound): StatusTrackingStep {
  const code = workingModeCodeForText(round.fields.working_mode);
  if (!code) return unreadable(previous, round, `working_mode ${JSON.stringify(round.fields.working_mode)}`);
  const previousMode = previous.status.working_mode;
  const sameMode = previousMode?.code === code;
  const current: InverterWorkingModeReading = {
    code,
    text: WORKING_MODE_TEXT_BY_CODE[code],
    since: sameMode ? previousMode.since : round.decodedAt,
    since_is_onset: sameMode ? previousMode.since_is_onset : previousMode !== undefined,
    time: round.decodedAt,
  };
  return {
    tracking: { ...previous, status: { ...previous.status, working_mode: current } },
    events: sameMode ? [] : [{ kind: "working_mode_changed", previous: previousMode, current }],
    requestedQueries: sameMode || !previousMode ? [] : ["CFS", "WS"],
  };
}

function afterLatestFaultReading(previous: InverterStatusTracking, round: DecodedRound): StatusTrackingStep {
  const { latest_fault_code: code, latest_fault_record_id: recordId } = round.fields;
  if (typeof code !== "number" || typeof recordId !== "number") {
    return unreadable(previous, round, `fields ${JSON.stringify(round.fields)}`);
  }
  const previousFault = previous.status.latest_fault;
  const sameFault = previousFault?.code === code && previousFault.record_id === recordId;
  const current: InverterLatestFaultReading = {
    code,
    text: describeInverterFaultCode(code),
    record_id: recordId,
    since: sameFault ? previousFault.since : round.decodedAt,
    time: round.decodedAt,
  };
  return {
    tracking: { ...previous, status: { ...previous.status, latest_fault: current } },
    events: sameFault ? [] : [{ kind: "latest_fault_changed", previous: previousFault, current }],
    requestedQueries: sameFault || !previousFault ? [] : ["MOD", ...ALL_FAULT_RECORD_QUERIES],
  };
}

function afterWarningsReading(previous: InverterStatusTracking, round: DecodedRound): StatusTrackingStep {
  const active = WARNING_FLAG_NAMES.filter(flag => round.fields[flag.key] === "active").map(flag => flag.name);
  const previouslyActive = previous.status.warnings?.active;
  const sameFlags =
    previouslyActive !== undefined &&
    previouslyActive.length === active.length &&
    previouslyActive.every(name => active.includes(name));
  return {
    tracking: { ...previous, status: { ...previous.status, warnings: { active, time: round.decodedAt } } },
    events: sameFlags ? [] : [{ kind: "warnings_changed", previouslyActive, active }],
    requestedQueries: [],
  };
}

function afterFaultRecordReading(previous: InverterStatusTracking, round: DecodedRound): StatusTrackingStep {
  const record = faultRecordOf(round.fields, round.decodedAt);
  if (!record) return unreadable(previous, round, `fields ${JSON.stringify(round.fields).slice(0, 200)}`);
  const lastRead = previous.status.fault_records.find(existing => existing.record_id === record.record_id);
  const sameContent =
    lastRead !== undefined &&
    lastRead.fault_code === record.fault_code &&
    lastRead.recorded_at_text === record.recorded_at_text &&
    lastRead.work_mode === record.work_mode &&
    lastRead.snapshot === record.snapshot;
  const faultRecords = [
    ...previous.status.fault_records.filter(existing => existing.record_id !== record.record_id),
    record,
  ].sort((first, second) => first.record_id - second.record_id);
  return {
    tracking: { ...previous, status: { ...previous.status, fault_records: faultRecords } },
    events: sameContent ? [] : [{ kind: "fault_record_read", record, changedSinceLastRead: lastRead !== undefined }],
    requestedQueries: [],
  };
}

function afterTelemetryReading(previous: InverterStatusTracking, round: DecodedRound): StatusTrackingStep {
  const tracking = { ...previous };
  if (round.command === "GS" && typeof round.fields.battery_current === "number") {
    tracking.batteryCurrentIsZero = round.fields.battery_current === 0;
  }
  if (round.command === "PS") {
    tracking.powerDirectionsIdle =
      round.fields.battery_power_direction === "Idle" && round.fields["dc/ac_power_direction"] === "Idle";
  }
  const dcIdleNow = tracking.batteryCurrentIsZero === true && tracking.powerDirectionsIdle === true;
  const signatureAppeared = dcIdleNow && !previous.dcIdleReported;
  tracking.dcIdleReported = dcIdleNow;
  const requestAllowed =
    previous.lastDcIdleModeRequestAt === undefined ||
    round.decodedAt - previous.lastDcIdleModeRequestAt >= DC_IDLE_MODE_REQUEST_MIN_INTERVAL_MS;
  if (!signatureAppeared || !requestAllowed) return { tracking, events: [], requestedQueries: [] };
  tracking.lastDcIdleModeRequestAt = round.decodedAt;
  return { tracking, events: [{ kind: "dc_idle_reported" }], requestedQueries: ["MOD"] };
}

function faultRecordOf(fields: DecodedFields, decodedAt: number): InverterFaultRecord | undefined {
  const {
    fault_record_id: recordId,
    fault_record_fault_code: faultCode,
    fault_record_time: recordedAtText,
    fault_record_work_mode: workModeCode,
  } = fields;
  if (typeof recordId !== "number" || typeof faultCode !== "number") return undefined;
  const knownWorkModeCode = knownWorkingModeCode(workModeCode);
  return {
    record_id: recordId,
    fault_code: faultCode,
    fault_text: describeInverterFaultCode(faultCode),
    recorded_at_text: typeof recordedAtText === "string" ? recordedAtText : "",
    work_mode: knownWorkModeCode
      ? `${WORKING_MODE_TEXT_BY_CODE[knownWorkModeCode]} (${knownWorkModeCode})`
      : String(workModeCode ?? ""),
    snapshot: FAULT_RECORD_SNAPSHOT_KEYS.map(key => String(fields[key] ?? "")).join(","),
    time: decodedAt,
  };
}

const WORKING_MODE_CODES = Object.keys(WORKING_MODE_TEXT_BY_CODE) as InverterWorkingModeCode[];

/** MOD decodes to the mode's name (str_keyed), so map it back to the code alerts reason about */
function workingModeCodeForText(text: DecodedFields[string] | undefined): InverterWorkingModeCode | undefined {
  return WORKING_MODE_CODES.find(code => WORKING_MODE_TEXT_BY_CODE[code] === text);
}

/** An HFS record stores the bare code */
function knownWorkingModeCode(code: DecodedFields[string] | undefined): InverterWorkingModeCode | undefined {
  return WORKING_MODE_CODES.find(knownCode => knownCode === code);
}

function unreadable(previous: InverterStatusTracking, round: DecodedRound, detail: string): StatusTrackingStep {
  return {
    tracking: previous,
    events: [{ kind: "unreadable_round", command: round.command, detail }],
    requestedQueries: [],
  };
}
