/**
 * Self-test for the inverter status queries: MOD/CFS/WS/HFS decoding of this inverter's real
 * answers, the fault-code texts, the status poll plan and the status tracker (incl. the log
 * lines). Pure, no hardware. Run from backend/ with:
 *   yarn node src/inverterComms/inverterStatus.selftest.ts
 */
import process from "process";
import { decodeQueryPayload } from "./pi17Decode.ts";
import { describeInverterFaultCode } from "./inverterFaultCodes.ts";
import {
  afterLinkRecovered,
  afterPeriodicQueryAnswered,
  afterPeriodicQueryUnanswered,
  ALL_FAULT_RECORD_QUERIES,
  decodeTableOfStatusQuery,
  initialStatusPollPlan,
  STATUS_POLL_INTERVAL_MS,
  STATUS_QUERY_BACKOFF_MS,
  STATUS_QUERY_FAILURES_BEFORE_BACKOFF,
  type StatusPollPlan,
  takeStatusQueriesForRound,
  withoutFaultRecordQueries,
  withStatusQueriesRequested,
  withUnrunQueriesRequeued,
} from "./statusPollPlan.ts";
import { PI17_QUERY_RESPONSE_FIELDS, WARNING_FLAGS_SET_EVERY_NIGHT } from "./pi17FieldTables.ts";
import {
  afterDecodedRound,
  DC_IDLE_MODE_REQUEST_MIN_INTERVAL_MS,
  INITIAL_INVERTER_STATUS_TRACKING,
  type InverterStatusTracking,
  type StatusTrackingStep,
} from "./inverterStatusTracking.ts";
import { describeInverterStatusEvent } from "./inverterStatusLogText.ts";
import { afterStatusQueryOutcome, type QueryOutcome } from "./statusPollRound.ts";
import { setOnErrorLog } from "../utilities/logging.ts";
import type { DecodedFields, DecodedRound, Pi17QueryCommandName } from "./pi17Protocol.types.ts";
import {
  CFS_FAULT_14_PAYLOAD,
  HFS00_PAYLOAD,
  MOD_FAULT_PAYLOAD,
  MOD_HYBRID_PAYLOAD,
  WS_DAY_PAYLOAD,
  WS_NIGHT_PAYLOAD,
} from "./pi17StatusFixtures.ts";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.error(`FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

// 2026-10-21 04:15:06 UTC, the latch
const LATCH_MS = +new Date("2026-10-21T04:15:06Z");

function round(command: Pi17QueryCommandName, payload: string, decodedAt: number): DecodedRound {
  return { command, fields: decodeQueryPayload(command, payload).fields, decodedAt };
}

function roundWithFields(command: Pi17QueryCommandName, fields: DecodedFields, decodedAt: number): DecodedRound {
  return { command, fields, decodedAt };
}

function replay(rounds: readonly DecodedRound[], from: InverterStatusTracking = INITIAL_INVERTER_STATUS_TRACKING) {
  const steps: StatusTrackingStep[] = [];
  let tracking = from;
  for (const decodedRound of rounds) {
    const step = afterDecodedRound(tracking, decodedRound);
    steps.push(step);
    tracking = step.tracking;
  }
  return { tracking, steps };
}

// ——— decoding this inverter's real answers ———
check("MOD 04 decodes as Fault mode", decodeQueryPayload("MOD", MOD_FAULT_PAYLOAD), {
  fields: { working_mode: "Fault mode" },
  problems: [],
});
check("CFS 14,00 decodes as fault 14 in flash slot 0", decodeQueryPayload("CFS", CFS_FAULT_14_PAYLOAD), {
  fields: { latest_fault_code: 14, latest_fault_record_id: 0 },
  problems: [],
});
{
  const nightFlags = decodeQueryPayload("WS", WS_NIGHT_PAYLOAD).fields;
  check(
    "WS at night: solar input 1/2 loss and the 23rd flag (equalization state) set, nothing else",
    Object.entries(nightFlags)
      .filter(([, flag]) => flag === "active")
      .map(([key]) => key),
    ["solar_input_1_loss", "solar_input_2_loss", "equalization_state"]
  );
  check("WS: this firmware's 23 flags decode, the spec's 24th is absent", Object.keys(nightFlags).length, 23);
}
{
  const record = decodeQueryPayload("HFS", HFS00_PAYLOAD);
  check(
    "HFS00 decodes without problems into its 25 fields",
    [record.problems, Object.keys(record.fields).length],
    [[], 25]
  );
  check(
    "HFS00: slot 0, fault 12, the stored time and work mode verbatim",
    [
      record.fields.fault_record_id,
      record.fields.fault_record_fault_code,
      record.fields.fault_record_time,
      record.fields.fault_record_work_mode,
    ],
    [0, 12, "759900560005", "04"]
  );
}

// ——— fault code texts ———
check(
  "fault 14 carries the vendor's full text",
  describeInverterFaultCode(14),
  "F14 Inverter DC current exceed permit range when feed power"
);
check(
  "fault 57 quotes the manual first and the spec's reading after it",
  describeInverterFaultCode(57),
  "F57 Control board over temperature (PI17 spec: T-phase inverter over temperature)"
);
check(
  "fault 12 names the GFCI trip",
  describeInverterFaultCode(12),
  "F12 Leakage current exceed permit range (GFCI fault)"
);
check("fault 3 is zero-padded", describeInverterFaultCode(3).startsWith("F03 "), true);
check(
  "an unlisted code says so",
  describeInverterFaultCode(28),
  "F28 (not in the manual's or the PI17 spec's fault list)"
);

// ——— the status poll plan ———
{
  const startupRounds: string[][] = [];
  let plan: StatusPollPlan = initialStatusPollPlan();
  for (let roundIndex = 0; roundIndex < 10; roundIndex++) {
    const taken = takeStatusQueriesForRound(plan, roundIndex * 1_100);
    startupRounds.push(taken.queries);
    plan = taken.plan;
  }
  check("startup: MOD+CFS+WS in the first round, then one fault-record slot per round, then nothing", startupRounds, [
    ["MOD", "CFS", "WS", "HFS00"],
    ["HFS01"],
    ["HFS02"],
    ["HFS03"],
    ["HFS04"],
    ["HFS05"],
    ["HFS06"],
    ["HFS07"],
    ["HFS08"],
    [],
  ]);
  check(
    "the periodic three come back after the poll interval, not before",
    [
      takeStatusQueriesForRound(plan, STATUS_POLL_INTERVAL_MS - 1).queries,
      takeStatusQueriesForRound(plan, STATUS_POLL_INTERVAL_MS).queries,
    ],
    [[], ["MOD", "CFS", "WS"]]
  );
  const requested = withStatusQueriesRequested(plan, ["CFS", "WS", "CFS"]);
  check("a request is queued once and read in the next round", takeStatusQueriesForRound(requested, 20_000).queries, [
    "CFS",
    "WS",
  ]);
  check(
    "requested quick queries keep protocol order and share the round with one slot",
    takeStatusQueriesForRound(withStatusQueriesRequested(plan, ["WS", "HFS03", "MOD", "HFS04"]), 20_000).queries,
    ["MOD", "WS", "HFS03"]
  );
  const preempted = takeStatusQueriesForRound(withStatusQueriesRequested(plan, ["MOD", "HFS05"]), 20_000);
  check(
    "a preempted round's unrun queries go back to the front",
    takeStatusQueriesForRound(withUnrunQueriesRequeued(preempted.plan, ["HFS05"]), 21_000).queries,
    ["HFS05"]
  );
  check(
    "a slot that got no usable answer drops the rest of the batch, quick queries stay",
    withoutFaultRecordQueries(withStatusQueriesRequested(plan, ["HFS02", "MOD", "HFS03"])).requested,
    ["MOD"]
  );
  check(
    "every HFS slot decodes through the HFS table",
    [decodeTableOfStatusQuery("HFS07"), decodeTableOfStatusQuery("CFS"), ALL_FAULT_RECORD_QUERIES.length],
    ["HFS", "CFS", 9]
  );
}
{
  // Each periodic query's minute restarts with every read: the DC-idle MOD at 16 s is followed by the
  // next one a minute later, when the Fault-mode P1's 60 s can be confirmed
  let plan = takeStatusQueriesForRound(initialStatusPollPlan(), 0).plan;
  plan = takeStatusQueriesForRound(withStatusQueriesRequested(plan, ["MOD"]), 16_000).plan;
  check(
    "an out-of-cadence MOD restarts MOD's minute only",
    [
      takeStatusQueriesForRound(plan, 60_000).queries.filter(query => !query.startsWith("HFS")),
      takeStatusQueriesForRound(plan, 76_000).queries.filter(query => !query.startsWith("HFS")),
    ],
    [
      ["CFS", "WS"],
      ["MOD", "CFS", "WS"],
    ]
  );
}
{
  // A periodic query answered in a shape we reject backs off after 3 failures, and comes back on an answer
  let plan = initialStatusPollPlan();
  const backoffStarts: boolean[] = [];
  for (const failureAtMs of [0, 60_000, 120_000, 180_000]) {
    const failed = afterPeriodicQueryUnanswered(plan, "WS", failureAtMs);
    backoffStarts.push(failed.backoffStarted);
    plan = failed.plan;
  }
  check("the third failure in a row starts the back-off, reported once", backoffStarts, [false, false, true, false]);
  const lastTaken = { ...plan, lastTakenAtMsByQuery: { MOD: 180_000, CFS: 180_000, WS: 180_000 } };
  check(
    "a backed-off query isn't handed out, even when requested, until its back-off ends",
    [
      takeStatusQueriesForRound(withStatusQueriesRequested(lastTaken, ["WS"]), 240_000).queries.includes("WS"),
      takeStatusQueriesForRound(lastTaken, 180_000 + STATUS_QUERY_BACKOFF_MS).queries.includes("WS"),
      takeStatusQueriesForRound(lastTaken, 240_000).queries.includes("MOD"),
    ],
    [false, true, true]
  );
  const answered = afterPeriodicQueryAnswered(plan, "WS");
  check(
    "an answer ends the back-off and reports how many failures it ended",
    [answered.recoveredAfterFailures, answered.plan.failuresInARowByQuery.WS, answered.plan.backedOffUntilMsByQuery.WS],
    [4, undefined, undefined]
  );
  check(
    "the back-off waits 10 min and starts after 3 failures",
    [STATUS_QUERY_BACKOFF_MS, STATUS_QUERY_FAILURES_BEFORE_BACKOFF],
    [600_000, 3]
  );
}
{
  const warningFlagNames = new Set(PI17_QUERY_RESPONSE_FIELDS.WS.map(spec => spec.name));
  check(
    "the flags kept out of alert texts are real WS flag names",
    [...WARNING_FLAGS_SET_EVERY_NIGHT].every(flagName => warningFlagNames.has(flagName)),
    true
  );
}

// ——— the tracker, replaying 2026-10-21 ———
{
  const beforeLatch = replay([
    round("MOD", MOD_HYBRID_PAYLOAD, LATCH_MS - 120_000),
    round("CFS", "12,00", LATCH_MS - 119_000),
    round("WS", WS_DAY_PAYLOAD, LATCH_MS - 118_000),
    round("HFS", HFS00_PAYLOAD, LATCH_MS - 117_000),
  ]);
  check(
    "startup readings are baselines: one event each, no extra queries asked for",
    beforeLatch.steps.map(step => [step.events.map(event => event.kind), step.requestedQueries]),
    [
      [["working_mode_changed"], []],
      [["latest_fault_changed"], []],
      [["warnings_changed"], []],
      [["fault_record_read"], []],
    ]
  );
  check(
    "the startup log lines",
    beforeLatch.steps.flatMap(step => step.events.map(describeInverterStatusEvent)),
    [
      { level: "log", text: "Inverter working mode: Hybrid mode (Line mode, Grid mode) (05)" },
      {
        level: "log",
        text: "Inverter's latest recorded fault (CFS, sticky — not necessarily active): F12 Leakage current exceed permit range (GFCI fault) (flash slot 00)",
      },
      { level: "log", text: "Inverter warning flags: none" },
      {
        level: "log",
        text: "Inverter fault record slot 00: F12 Leakage current exceed permit range (GFCI fault), stored time 759900560005 (YYMMDDhhmmss per the spec), work mode Fault mode (04), value snapshot (alignment unverified) 05850,00012,00080,02313,2296,2298,4996,0410,7599,+0309,2294,2300,4996,0115,00045,00138,00001,029,046,000,000",
      },
    ]
  );
  check(
    "the tracked status after startup",
    [
      beforeLatch.tracking.status.working_mode,
      beforeLatch.tracking.status.latest_fault,
      beforeLatch.tracking.status.warnings,
      beforeLatch.tracking.status.fault_records.map(record => [record.record_id, record.fault_code, record.work_mode]),
    ],
    [
      {
        code: "05",
        text: "Hybrid mode (Line mode, Grid mode)",
        since: LATCH_MS - 120_000,
        // The first reading after a start: the mode may have held long before
        since_is_onset: false,
        time: LATCH_MS - 120_000,
      },
      {
        code: 12,
        text: "F12 Leakage current exceed permit range (GFCI fault)",
        record_id: 0,
        since: LATCH_MS - 119_000,
        time: LATCH_MS - 119_000,
      },
      { active: [], time: LATCH_MS - 118_000 },
      [[0, 12, "Fault mode (04)"]],
    ]
  );

  // The charge ends: GS reads 0 A, PS Idle/Idle, and the tracker asks for MOD at once
  const charging = { battery_current: 26.2 };
  const idlePs = { battery_power_direction: "Idle", "dc/ac_power_direction": "Idle" };
  const latch = replay(
    [
      roundWithFields("GS", charging, LATCH_MS - 2_000),
      roundWithFields(
        "PS",
        { battery_power_direction: "Charging", "dc/ac_power_direction": "AC to DC" },
        LATCH_MS - 1_500
      ),
      roundWithFields("GS", { battery_current: 0 }, LATCH_MS + 6_000),
      roundWithFields("PS", idlePs, LATCH_MS + 6_500),
      roundWithFields("GS", { battery_current: 0 }, LATCH_MS + 7_000),
      round("MOD", MOD_FAULT_PAYLOAD, LATCH_MS + 8_000),
      round("CFS", CFS_FAULT_14_PAYLOAD, LATCH_MS + 9_000),
      round("WS", WS_DAY_PAYLOAD, LATCH_MS + 9_500),
      round("MOD", MOD_FAULT_PAYLOAD, LATCH_MS + 10_000),
      round("HFS", HFS00_PAYLOAD, LATCH_MS + 11_000),
      round("MOD", MOD_FAULT_PAYLOAD, LATCH_MS + 70_000),
    ],
    beforeLatch.tracking
  );
  check(
    "the latch: DC idle → MOD asked for → Fault mode → CFS+WS asked for → fault 12→14 → MOD + every slot asked for",
    latch.steps.map(step => [step.events.map(event => event.kind), step.requestedQueries]),
    [
      [[], []],
      [[], []],
      [[], []],
      [["dc_idle_reported"], ["MOD"]],
      [[], []],
      [["working_mode_changed"], ["CFS", "WS"]],
      [["latest_fault_changed"], ["MOD", ...ALL_FAULT_RECORD_QUERIES]],
      [[], []],
      [[], []],
      // Slot 00 still holds the fault 12 record: an unchanged slot isn't logged again
      [[], []],
      [[], []],
    ]
  );
  check("Fault mode keeps its first reading as `since` while it lasts", latch.tracking.status.working_mode, {
    code: "04",
    text: "Fault mode",
    since: LATCH_MS + 8_000,
    // A Hybrid reading came before it, so this is the real onset
    since_is_onset: true,
    time: LATCH_MS + 70_000,
  });
  check(
    "the latch's log lines: a warning for Fault mode and for the new code",
    latch.steps.flatMap(step => step.events.map(describeInverterStatusEvent)),
    [
      {
        level: "debug",
        text: "Inverter reports its DC side idle (0 A, battery and DC/AC Idle) — reading the working mode now",
      },
      {
        level: "warn",
        text: "Inverter working mode changed: Hybrid mode (Line mode, Grid mode) (05) → Fault mode (04), after 2 min in the previous mode",
      },
      {
        level: "warn",
        text: "Inverter recorded a new fault: F14 Inverter DC current exceed permit range when feed power (flash slot 00); before it: F12 Leakage current exceed permit range (GFCI fault) (flash slot 00). Reading the working mode and the fault records.",
      },
    ]
  );

  // A low-voltage cut-off flapping in and out of the idle picture asks for MOD at most every 30 s
  const flapping = replay(
    [0, 1, 2, 3, 4, 5].flatMap(cycle => [
      roundWithFields("GS", { battery_current: cycle % 2 ? -0.5 : 0 }, LATCH_MS + cycle * 10_000),
      roundWithFields("PS", idlePs, LATCH_MS + cycle * 10_000 + 500),
    ])
  );
  check(
    "a flapping idle signature is rate-limited to one MOD request per 30 s",
    flapping.steps.flatMap((step, stepIndex) => (step.requestedQueries.length ? [stepIndex] : [])),
    // The PS of cycle 0 (t=0.5 s) completes the picture, then the GS of cycle 4 (t=40 s, PS still
    // Idle); cycle 2's GS at t=20 s is too soon after the first request
    [1, 8]
  );
  check("the rate limit is 30 s", DC_IDLE_MODE_REQUEST_MIN_INTERVAL_MS, 30_000);

  // Recovery, 59 h later: Hybrid again, CFS still 14 (sticky), warnings back at night
  const recovery = replay(
    [
      round("MOD", MOD_HYBRID_PAYLOAD, LATCH_MS + 59 * 3_600_000),
      round("CFS", CFS_FAULT_14_PAYLOAD, LATCH_MS + 59 * 3_600_000 + 1_000),
      round("WS", WS_NIGHT_PAYLOAD, LATCH_MS + 59 * 3_600_000 + 2_000),
      round("WS", WS_DAY_PAYLOAD, LATCH_MS + 62 * 3_600_000),
    ],
    latch.tracking
  );
  check(
    "recovery: the mode change asks for CFS+WS, the sticky CFS raises nothing",
    recovery.steps.map(step => [step.events.map(event => event.kind), step.requestedQueries]),
    [
      [["working_mode_changed"], ["CFS", "WS"]],
      [[], []],
      [["warnings_changed"], []],
      [["warnings_changed"], []],
    ]
  );
  check(
    "recovery log lines",
    recovery.steps.flatMap(step => step.events.map(event => describeInverterStatusEvent(event).text)),
    [
      "Inverter working mode changed: Fault mode (04) → Hybrid mode (Line mode, Grid mode) (05), after 59 h 0 min in the previous mode",
      "Inverter warning flags raised Solar input 1 loss, Solar input 2 loss, Equalization state — now active: Solar input 1 loss, Solar input 2 loss, Equalization state",
      "Inverter warning flags cleared Solar input 1 loss, Solar input 2 loss, Equalization state — now active: none",
    ]
  );

  // A slot whose content changes is logged again, flagged as changed
  const rewritten = replay(
    [round("HFS", HFS00_PAYLOAD.replace(/^00,12,/, "00,14,"), LATCH_MS + 3_600_000)],
    latch.tracking
  );
  check(
    "a rewritten slot is reported as changed and replaces the old record",
    [
      rewritten.steps[0]!.events.map(event =>
        event.kind === "fault_record_read" ? event.changedSinceLastRead : event.kind
      ),
      rewritten.tracking.status.fault_records.map(record => record.fault_code),
    ],
    [[true], [14]]
  );
}

// ——— a round's outcome for the plan: back-off reported once (errorLog → P2), CFS's latest slot kept ———
{
  const errorLogged: string[] = [];
  setOnErrorLog(args => errorLogged.push(args.map(String).join(" ")));
  let plan = initialStatusPollPlan();
  for (const failureAtMs of [0, 60_000, 120_000, 180_000]) {
    plan = afterStatusQueryOutcome(plan, "MOD", { kind: "unanswered" }, failureAtMs, true);
  }
  setOnErrorLog(undefined);
  check(
    "a status query failing 4 times while GS/PS answer errorLogs once, when its back-off starts",
    [errorLogged.length, errorLogged[0]?.startsWith("Inverter status query MOD failed 3 times in a row")],
    [1, true]
  );
  const cfsAnswered = afterStatusQueryOutcome(
    plan,
    "CFS",
    { kind: "decoded", fields: decodeQueryPayload("CFS", "14,03").fields },
    200_000,
    true
  );
  check("a CFS answer keeps its latest flash slot for the NAK check", cfsAnswered.latestFaultRecordId, 3);
  check(
    "GS/PS/settings queries leave the plan alone",
    afterStatusQueryOutcome(plan, undefined, { kind: "unanswered" }, 200_000, true) === plan,
    true
  );
  const slotDuringOutage = afterStatusQueryOutcome(
    { ...initialStatusPollPlan(), requested: ["HFS04"] },
    "HFS03",
    { kind: "unanswered" },
    0,
    false
  );
  check("a fault-record slot lost to an outage is tried again, not abandoned", slotDuringOutage.requested, [
    "HFS03",
    "HFS04",
  ]);
  const recovered = afterLinkRecovered(plan);
  check(
    "link recovery clears every back-off and asks for MOD, CFS and WS at once",
    [
      recovered.backedOffUntilMsByQuery,
      recovered.failuresInARowByQuery,
      recovered.requested.filter(query => !query.startsWith("HFS")),
    ],
    [{}, {}, ["MOD", "CFS", "WS"]]
  );
}

// ——— the review's replay: the inverter silent for 5 min (the P1's own power-cycle), the FTDI line open ———
{
  const errorLogged: string[] = [];
  setOnErrorLog(args => errorLogged.push(args.map(String).join(" ")));
  const replay = replayLinkSilence({ silentFromMs: 30_000, silentUntilMs: 330_000, untilMs: 25 * 60_000 });
  setOnErrorLog(undefined);
  check(
    "a 5-min silence: no status-query errorLog (no extra P2), and MOD is read the round after GS answers again",
    [
      errorLogged.length,
      replay.linkBackAtMs !== undefined &&
        replay.firstModAnsweredAfterRecoveryMs !== undefined &&
        replay.firstModAnsweredAfterRecoveryMs - replay.linkBackAtMs < 2_500,
    ],
    [0, true]
  );
}

// ——— an unreadable round can't happen behind the gate; if it does it is reported, not swallowed ———
{
  const step = afterDecodedRound(
    INITIAL_INVERTER_STATUS_TRACKING,
    roundWithFields("MOD", { working_mode: "Unknown key: 07" }, LATCH_MS)
  );
  check(
    "an unknown working mode is reported and changes nothing",
    [
      step.events.map(event => describeInverterStatusEvent(event).level),
      step.tracking === INITIAL_INVERTER_STATUS_TRACKING,
    ],
    [["warn"], true]
  );
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll inverter status checks passed");

/**
 * The session's round order over a silent inverter (the reviewer's replay): GS and PS first, then the
 * status queries; answered queries take ~0.1 s, unanswered ones 2 × 3 s + quiet, and the session's
 * link counter decides `linkAnswering` and the recovery — exactly as inverterSession.ts does.
 */
function replayLinkSilence(timing: { silentFromMs: number; silentUntilMs: number; untilMs: number }) {
  let plan: StatusPollPlan = { ...initialStatusPollPlan(), requested: [] };
  let consecutiveLinkFailures = 0;
  let firstModAnsweredAfterRecoveryMs: number | undefined;
  /** When GS answered again: the session only learns the line is back from it */
  let linkBackAtMs: number | undefined;
  let nowMs = 0;
  while (nowMs < timing.untilMs) {
    const taken = takeStatusQueriesForRound(plan, nowMs);
    plan = taken.plan;
    const silent = nowMs >= timing.silentFromMs && nowMs < timing.silentUntilMs;
    // GS + PS
    nowMs += silent ? 13_000 : 1_000;
    if (silent) consecutiveLinkFailures += 2;
    else if (consecutiveLinkFailures) {
      consecutiveLinkFailures = 0;
      linkBackAtMs = nowMs;
      plan = afterLinkRecovered(plan);
    }
    for (const query of taken.queries) {
      nowMs += silent ? 6_500 : 100;
      const outcome: QueryOutcome = silent
        ? { kind: "unanswered" }
        : { kind: "decoded", fields: { working_mode: "Fault mode", latest_fault_code: 14, latest_fault_record_id: 0 } };
      plan = afterStatusQueryOutcome(plan, query, outcome, nowMs, consecutiveLinkFailures === 0);
      if (query === "MOD" && linkBackAtMs !== undefined) firstModAnsweredAfterRecoveryMs ??= nowMs;
    }
    if (silent) nowMs += 1_000;
  }
  return { firstModAnsweredAfterRecoveryMs, linkBackAtMs };
}
