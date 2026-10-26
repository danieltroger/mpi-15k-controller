/**
 * Which status queries (MOD / CFS / WS / HFS) ride along on the next background poll round — pure
 * state + transitions, no I/O; times are the session's monotonic clock.
 *
 * Kept apart from schedulerCore.ts on purpose: status queries never interact with setters or
 * their confirms, so they simply join GS/PS rounds the scheduler has already decided to run. The
 * cost to the GS/PS cadence (~53 rounds/min): MOD + CFS + WS put ~100 B on the wire (0.4 s at 2400
 * baud) plus ~50 ms of answer latency each, ≈ 0.6 s once a minute, about half a round. An HFS
 * exchange is ~150 B ≈ 0.6 s on its own, so those go one per round rather than nine in a row (a
 * ~6 s hole in the telemetry).
 */
import type { FaultRecordId, InverterStatusQuery } from "./inverterStatus.types.ts";
import type { Pi17QueryCommandName } from "./pi17Protocol.types.ts";

export const STATUS_POLL_INTERVAL_MS = 60_000;
/** Canonical order within a round: the working mode first, it is the one an alert hangs on */
export const PERIODIC_STATUS_QUERIES = ["MOD", "CFS", "WS"] as const satisfies readonly InverterStatusQuery[];
export type PeriodicStatusQuery = (typeof PERIODIC_STATUS_QUERIES)[number];
export const FAULT_RECORD_IDS: readonly FaultRecordId[] = [0, 1, 2, 3, 4, 5, 6, 7, 8];
export const ALL_FAULT_RECORD_QUERIES: readonly InverterStatusQuery[] = FAULT_RECORD_IDS.map(faultRecordQuery);
/**
 * A periodic query answered in a shape we reject costs two 3 s timeouts + the 1 s failure gap —
 * a ~7 s hole in GS/PS — every minute. After this many failures in a row it is only tried every
 * STATUS_QUERY_BACKOFF_MS, until it answers again.
 */
export const STATUS_QUERY_FAILURES_BEFORE_BACKOFF = 3;
export const STATUS_QUERY_BACKOFF_MS = 10 * 60_000;

export type StatusPollPlan = {
  /**
   * When each periodic query was last handed out. Each query's minute restarts with every read, so
   * an out-of-cadence MOD (the DC-idle trigger) is followed by the next one a minute later —
   * exactly when the Fault-mode P1's 60 s can be confirmed, instead of up to two minutes later.
   */
  lastTakenAtMsByQuery: Readonly<Partial<Record<PeriodicStatusQuery, number>>>;
  /** Asked for out of cadence (by the status tracker, or left over from a preempted round), in order */
  requested: readonly InverterStatusQuery[];
  failuresInARowByQuery: Readonly<Partial<Record<PeriodicStatusQuery, number>>>;
  /** A periodic query that kept failing isn't handed out again before this */
  backedOffUntilMsByQuery: Readonly<Partial<Record<PeriodicStatusQuery, number>>>;
  /** CFS's latest flash slot: a NAK for that slot isn't an empty slot */
  latestFaultRecordId: number | undefined;
};

/** At startup every fault-record slot is read once, so the log holds what the flash knows. */
export function initialStatusPollPlan(): StatusPollPlan {
  return {
    lastTakenAtMsByQuery: {},
    requested: ALL_FAULT_RECORD_QUERIES,
    failuresInARowByQuery: {},
    backedOffUntilMsByQuery: {},
    latestFaultRecordId: undefined,
  };
}

/**
 * The status queries for the round starting now: each periodic one that is due or requested (and
 * not backed off), and at most one fault record (the slowest answer by far).
 */
export function takeStatusQueriesForRound(
  plan: StatusPollPlan,
  nowMs: number
): { queries: InverterStatusQuery[]; plan: StatusPollPlan } {
  const quickQueries = PERIODIC_STATUS_QUERIES.filter(query => {
    const backedOffUntilMs = plan.backedOffUntilMsByQuery[query];
    if (backedOffUntilMs !== undefined && nowMs < backedOffUntilMs) return false;
    const lastTakenAtMs = plan.lastTakenAtMsByQuery[query];
    return (
      plan.requested.includes(query) || lastTakenAtMs === undefined || nowMs - lastTakenAtMs >= STATUS_POLL_INTERVAL_MS
    );
  });
  const nextFaultRecordQuery = plan.requested.find(isFaultRecordQuery);
  const queries: InverterStatusQuery[] = nextFaultRecordQuery ? [...quickQueries, nextFaultRecordQuery] : quickQueries;
  const lastTakenAtMsByQuery = { ...plan.lastTakenAtMsByQuery };
  for (const query of quickQueries) lastTakenAtMsByQuery[query] = nowMs;
  return {
    queries,
    plan: { ...plan, lastTakenAtMsByQuery, requested: plan.requested.filter(query => !queries.includes(query)) },
  };
}

/** Ask for queries out of cadence; already-requested ones aren't duplicated. */
export function withStatusQueriesRequested(
  plan: StatusPollPlan,
  queries: readonly InverterStatusQuery[]
): StatusPollPlan {
  const added = queries.filter((query, index) => !plan.requested.includes(query) && queries.indexOf(query) === index);
  return added.length ? { ...plan, requested: [...plan.requested, ...added] } : plan;
}

/**
 * A round a control write cut short leaves its status queries unrun: they go to the front of the
 * queue, so a preempted periodic poll isn't silently skipped until the next minute.
 */
export function withUnrunQueriesRequeued(
  plan: StatusPollPlan,
  unrunQueries: readonly InverterStatusQuery[]
): StatusPollPlan {
  if (!unrunQueries.length) return plan;
  return { ...plan, requested: [...unrunQueries, ...plan.requested.filter(query => !unrunQueries.includes(query))] };
}

/**
 * A fault record that got no usable answer (as opposed to a NAK for an empty slot) means this
 * firmware answers HFS in a way we can't take — every further slot would cost another 3 s timeout +
 * retry of dead line, so the rest of this batch is abandoned. A later fault-code change asks again.
 */
export function withoutFaultRecordQueries(plan: StatusPollPlan): StatusPollPlan {
  return { ...plan, requested: plan.requested.filter(query => !isFaultRecordQuery(query)) };
}

/** `backoffStarted` only on the failure that crosses the threshold, so the caller reports it once */
export function afterPeriodicQueryUnanswered(
  plan: StatusPollPlan,
  query: PeriodicStatusQuery,
  nowMs: number
): { plan: StatusPollPlan; backoffStarted: boolean } {
  const failuresInARow = (plan.failuresInARowByQuery[query] ?? 0) + 1;
  const backedOff = failuresInARow >= STATUS_QUERY_FAILURES_BEFORE_BACKOFF;
  return {
    plan: {
      ...plan,
      failuresInARowByQuery: { ...plan.failuresInARowByQuery, [query]: failuresInARow },
      backedOffUntilMsByQuery: backedOff
        ? { ...plan.backedOffUntilMsByQuery, [query]: nowMs + STATUS_QUERY_BACKOFF_MS }
        : plan.backedOffUntilMsByQuery,
    },
    backoffStarted: failuresInARow === STATUS_QUERY_FAILURES_BEFORE_BACKOFF,
  };
}

/** `recoveredAfterFailures`: how many failures in a row this answer ended (0 when none) */
export function afterPeriodicQueryAnswered(
  plan: StatusPollPlan,
  query: PeriodicStatusQuery
): { plan: StatusPollPlan; recoveredAfterFailures: number } {
  const recoveredAfterFailures = plan.failuresInARowByQuery[query] ?? 0;
  if (!recoveredAfterFailures) return { plan, recoveredAfterFailures };
  const failuresInARowByQuery = { ...plan.failuresInARowByQuery };
  delete failuresInARowByQuery[query];
  const backedOffUntilMsByQuery = { ...plan.backedOffUntilMsByQuery };
  delete backedOffUntilMsByQuery[query];
  return { plan: { ...plan, failuresInARowByQuery, backedOffUntilMsByQuery }, recoveredAfterFailures };
}

/**
 * The link answers again after an outage: the status queries' failure counts and back-offs were
 * nothing of theirs, and the inverter may have changed mode meanwhile (the P1's power-cycle
 * procedure is one such outage), so all three are read at once — a quick Resolved, and a re-latch
 * right after it can't fold into the old episode unseen.
 */
export function afterLinkRecovered(plan: StatusPollPlan): StatusPollPlan {
  return withStatusQueriesRequested(
    { ...plan, failuresInARowByQuery: {}, backedOffUntilMsByQuery: {} },
    PERIODIC_STATUS_QUERIES
  );
}

export function isPeriodicStatusQuery(query: InverterStatusQuery): query is PeriodicStatusQuery {
  return PERIODIC_STATUS_QUERIES.some(periodicQuery => periodicQuery === query);
}

export function isFaultRecordQuery(query: InverterStatusQuery): query is `HFS0${FaultRecordId}` {
  return query.startsWith("HFS");
}

/** The slot an HFS query asks for (HFS03 → 3) */
export function faultRecordIdOfQuery(query: `HFS0${FaultRecordId}`): FaultRecordId {
  return Number(query.slice(3)) as FaultRecordId;
}

/** The decode table / response shape a status query's answer is read with (every HFS slot shares one) */
export function decodeTableOfStatusQuery(
  query: InverterStatusQuery
): Extract<Pi17QueryCommandName, "MOD" | "CFS" | "WS" | "HFS"> {
  return isFaultRecordQuery(query) ? "HFS" : query;
}

export function faultRecordQuery(recordId: FaultRecordId): `HFS0${FaultRecordId}` {
  return `HFS0${recordId}`;
}
