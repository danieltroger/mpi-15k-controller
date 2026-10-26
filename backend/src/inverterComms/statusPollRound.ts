/**
 * How the status queries statusPollPlan.ts hands out join a background poll round, and what each
 * one's outcome means for the plan (and the log) — kept out of inverterSession.ts, which only runs
 * the round.
 */
import { errorLog, logLog, warnLog } from "../utilities/logging.ts";
import type { FaultRecordId, InverterStatusQuery } from "./inverterStatus.types.ts";
import type { DecodedFields, Pi17QueryCommandName } from "./pi17Protocol.types.ts";
import {
  afterPeriodicQueryAnswered,
  afterPeriodicQueryUnanswered,
  decodeTableOfStatusQuery,
  faultRecordIdOfQuery,
  isFaultRecordQuery,
  isPeriodicStatusQuery,
  STATUS_QUERY_BACKOFF_MS,
  STATUS_QUERY_FAILURES_BEFORE_BACKOFF,
  type StatusPollPlan,
  withoutFaultRecordQueries,
  withUnrunQueriesRequeued,
} from "./statusPollPlan.ts";

/** The round's queries in order: the background/settings commands first, then the status queries */
export function roundQueriesWithStatus(
  commands: readonly Pi17QueryCommandName[],
  statusQueries: readonly InverterStatusQuery[]
): RoundQuery[] {
  return [
    ...commands.map(command => ({ command, wireCommand: command, statusQuery: undefined })),
    ...statusQueries.map(statusQuery => ({
      command: decodeTableOfStatusQuery(statusQuery),
      wireCommand: statusQuery,
      statusQuery,
    })),
  ];
}

/** One query of a poll round; `statusQuery` marks the ones statusPollPlan.ts handed out */
export type RoundQuery = {
  /** The decode table / response shape (HFS for every fault-record slot) */
  command: Pi17QueryCommandName;
  /** What goes on the wire: HFS03, not HFS */
  wireCommand: string;
  statusQuery: InverterStatusQuery | undefined;
};

/**
 * "declined": the inverter NAKed a query it may decline (a fault-record slot, see
 * pi17ResponseShapes.ts). "unanswered": no response, a round the gate dropped, or disposal.
 */
export type QueryOutcome = { kind: "decoded"; fields: DecodedFields } | { kind: "declined" } | { kind: "unanswered" };

/** A control write cut the round short: its unrun status queries go back to the front of the plan */
export function afterRoundPreempted(plan: StatusPollPlan, unrunQueries: readonly RoundQuery[]): StatusPollPlan {
  const unrunStatusQueries = unrunQueries.flatMap(roundQuery =>
    roundQuery.statusQuery ? [roundQuery.statusQuery] : []
  );
  return withUnrunQueriesRequeued(plan, unrunStatusQueries);
}

/**
 * What one status query's outcome changes in the plan; GS/PS/settings queries change nothing.
 * `linkAnswering`: GS/PS answered since the link's last failure. A status query that goes
 * unanswered while they don't is the outage's failure, not its own: it neither counts towards the
 * back-off (a 5-min silence would back MOD off for 10 min and push three P2s) nor abandons the
 * fault-record batch — the slot is simply tried again.
 */
export function afterStatusQueryOutcome(
  plan: StatusPollPlan,
  statusQuery: InverterStatusQuery | undefined,
  outcome: QueryOutcome,
  nowMs: number,
  linkAnswering: boolean
): StatusPollPlan {
  if (!statusQuery) return plan;
  if (outcome.kind === "unanswered" && !linkAnswering) {
    return isFaultRecordQuery(statusQuery) ? withUnrunQueriesRequeued(plan, [statusQuery]) : plan;
  }
  if (isFaultRecordQuery(statusQuery)) return afterFaultRecordOutcome(plan, statusQuery, outcome);
  if (!isPeriodicStatusQuery(statusQuery)) return plan;
  if (outcome.kind === "unanswered") {
    const failed = afterPeriodicQueryUnanswered(plan, statusQuery, nowMs);
    if (failed.backoffStarted) {
      // An errorLog (→ P2): the Fault-mode and Bypass alerts are blind while MOD is backed off
      errorLog(
        `Inverter status query ${statusQuery} failed ${STATUS_QUERY_FAILURES_BEFORE_BACKOFF} times in a row — trying it only every`,
        STATUS_QUERY_BACKOFF_MS / 60_000,
        "min until it answers again (the inverter fault alerts depend on MOD and CFS)"
      );
    }
    return failed.plan;
  }
  const answered = afterPeriodicQueryAnswered(plan, statusQuery);
  if (answered.recoveredAfterFailures >= STATUS_QUERY_FAILURES_BEFORE_BACKOFF) {
    logLog(`Inverter status query ${statusQuery} answers again after`, answered.recoveredAfterFailures, "failures");
  }
  const latestFaultRecordId = outcome.kind === "decoded" ? outcome.fields.latest_fault_record_id : undefined;
  return statusQuery === "CFS" && typeof latestFaultRecordId === "number"
    ? { ...answered.plan, latestFaultRecordId }
    : answered.plan;
}

function afterFaultRecordOutcome(
  plan: StatusPollPlan,
  statusQuery: `HFS0${FaultRecordId}`,
  outcome: QueryOutcome
): StatusPollPlan {
  const requestedSlot = faultRecordIdOfQuery(statusQuery);
  if (outcome.kind === "unanswered") {
    const remainingSlots = plan.requested.filter(isFaultRecordQuery);
    if (remainingSlots.length) {
      warnLog(
        `Inverter fault record ${statusQuery} got no usable answer — skipping`,
        remainingSlots.join(", "),
        "until the latest fault code changes"
      );
    }
    return withoutFaultRecordQueries(plan);
  }
  if (outcome.kind === "declined") {
    // Slot 00 answered the WiFi datalogger with a real record, and CFS names its latest slot: a
    // NAK for either is a framing or firmware signal, not an empty slot
    if (requestedSlot === 0 || requestedSlot === plan.latestFaultRecordId) {
      warnLog(
        `Inverter declined ${statusQuery} (NAK), a slot that should hold a record`,
        requestedSlot === 0 ? "(slot 00 always answered the datalogger)" : "(CFS names it as the latest)"
      );
    } else {
      logLog(`Inverter declined ${statusQuery} (NAK) — taken as an empty fault-record slot`);
    }
    return plan;
  }
  // The record's own slot field is 00 in every slot on this firmware, so it isn't checked: the
  // tracker files the record under the slot asked for (inverterFaultRecords.ts)
  return plan;
}
