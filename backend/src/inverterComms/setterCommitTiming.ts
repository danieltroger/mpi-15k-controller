/**
 * Per-setter commit measurement and the confirm-verdict log lines, so the inverter's commit
 * behaviour can be read straight from the log (#52): how long the inverter took to ACK, how long
 * from the ACK until a readback showed the write applied, and how much traffic went over the line
 * in between (an ACK is frame-level only — the commit lands seconds later).
 *
 * Every setter with a readback check gets exactly one "Inverter commit timing:" JSON line, at its
 * verdict: confirmed, never_applied (the loud give-up) or superseded (a newer write to the same
 * field replaced its check first). Times are the session's monotonic clock.
 */
import { debugLog, errorLog, logLog, warnLog } from "../utilities/logging.ts";
import type { ConfirmPhase, PendingReadbackCheck, StarvedWriteReport } from "./schedulerCore.ts";
import type { ConfirmVerdicts } from "./confirmVerdicts.ts";

/** Cumulative line traffic, sampled at the ACK and again at the verdict */
export type LineTraffic = { pollRoundsCompleted: number; framesWritten: number };

export type TrackedSetter = {
  command: string;
  ackLatencyMs: number;
  /** 2 when only the retry got the ACK */
  ackAttempts: number;
  ackedAtMs: number;
  trafficAtAck: LineTraffic;
  /** Confirm runs that still showed the old value, and when the latest of them ran */
  readbacksStillOld: number;
  lastStillOldAtMs: number | undefined;
};

/** In-flight measurements by setter command */
export type SetterCommitTracker = Map<string, TrackedSetter>;

export type CommitVerdict = "confirmed" | "never_applied" | "superseded";

/** What one "Inverter commit timing:" line carries */
export type CommitTimingRecord = {
  command: string;
  verdict: CommitVerdict;
  ackLatencyMs: number;
  ackAttempts: number;
  ackToVerdictMs: number;
  readbacksStillOld: number;
  /** ACK → the last confirm run that still showed the old value: the commit landed after this */
  lastStillOldAfterAckMs: number | null;
  pollRoundsBetween: number;
  framesBetween: number;
};

/**
 * Log an ACKed setter and start measuring it. Call after afterSetterSent, with the phase it armed:
 * a tracked setter whose checks that write replaced is reported (and returned) as superseded.
 */
export function reportAckedSetter(
  tracker: SetterCommitTracker,
  setter: Omit<TrackedSetter, "trafficAtAck" | "readbacksStillOld" | "lastStillOldAtMs">,
  confirm: ConfirmPhase | undefined,
  traffic: LineTraffic
): CommitTimingRecord[] {
  const { command, ackLatencyMs, ackAttempts, ackedAtMs } = setter;
  logLog(
    "Inverter ACKed",
    command,
    `in ${Math.round(ackLatencyMs)} ms${ackAttempts > 1 ? " (on the retry)" : ""}`,
    "— confirming the commit by readback, polling continuing"
  );
  // An identical rewrite keeps the command (and so its checks' command) — the older measurement ends here
  const commandsStillChecked = commandsOf(confirm?.checks ?? []);
  const superseded = [...tracker.values()].filter(
    tracked => tracked.command === command || !commandsStillChecked.has(tracked.command)
  );
  const records = superseded.map(tracked => reportVerdict(tracker, tracked, "superseded", ackedAtMs, traffic));
  if (commandsStillChecked.has(command)) {
    tracker.set(command, { ...setter, trafficAtAck: traffic, readbacksStillOld: 0, lastStillOldAtMs: undefined });
  }
  return records;
}

/**
 * Log one confirm run's outcome — the human lines plus a timing line per setter that reached its
 * verdict — and return those timing records.
 */
export function reportConfirmOutcome(
  tracker: SetterCommitTracker,
  outcome: ConfirmVerdicts,
  nowMs: number,
  traffic: LineTraffic,
  /** Give-ups whose field this starvation episode has already paged (giveUpsAlreadyPaged): logged, not paged */
  alreadyPagedGiveUps: readonly PendingReadbackCheck[] = []
): CommitTimingRecord[] {
  const { confirmedChecks, gaveUpChecks, retry } = outcome;
  if (confirmedChecks.length) logLog("Inverter write(s) confirmed applied:", describeChecks(confirmedChecks));
  const pagedGiveUps = gaveUpChecks.filter(check => !alreadyPagedGiveUps.includes(check));
  if (pagedGiveUps.length) {
    errorLog(
      "Inverter ACKed but never applied within the confirm window:",
      pagedGiveUps.map(check => `${check.forCommand} (wanted ${check.field}=${check.expectedValue})`).join(", "),
      "— leaving any re-send to the owning control loop (rate-limited by the 60 s identical-setter gate)"
    );
  }
  if (alreadyPagedGiveUps.length) {
    warnLog(
      "Inverter ACKed but never applied within the confirm window (field already paged as never applied):",
      alreadyPagedGiveUps.map(check => `${check.forCommand} (wanted ${check.field}=${check.expectedValue})`).join(", ")
    );
  }
  const neverApplied = commandsOf(gaveUpChecks);
  const stillPending = commandsOf(retry?.pendingChecks ?? []);
  // A check written too recently to judge was not seen "still old" — it only waits
  const seenStillOld = commandsOf(
    (retry?.pendingChecks ?? []).filter(check => !outcome.notYetJudgedChecks.includes(check))
  );
  if (retry && seenStillOld.size) {
    debugLog(
      "Inverter write(s) not visible in readback yet — re-checking in",
      Math.round(retry.retryAt - nowMs),
      "ms with polling continuing:",
      [...seenStillOld].join(", ")
    );
  }

  const confirmed = [...commandsOf(confirmedChecks)].filter(
    command => !neverApplied.has(command) && !stillPending.has(command)
  );
  const verdicts = [
    ...[...neverApplied].map(command => ({ command, verdict: "never_applied" as const })),
    ...confirmed.map(command => ({ command, verdict: "confirmed" as const })),
  ];
  const records = verdicts.flatMap(({ command, verdict }) =>
    reportTrackedVerdict(tracker, command, verdict, nowMs, traffic)
  );
  for (const command of seenStillOld) {
    const tracked = tracker.get(command);
    if (tracked) {
      tracker.set(command, { ...tracked, readbacksStillOld: tracked.readbacksStillOld + 1, lastStillOldAtMs: nowMs });
    }
  }
  return records;
}

/**
 * One errorLog (P2) per starved field: a readback STARVED_WRITE_PAGE_AFTER_MS after an ACKed write that
 * shows neither it nor any later write to the field, whose checks newer writes kept superseding before
 * their own give-up. The field pages again only after it has moved to a written value.
 */
export function reportStarvedWrites(reports: readonly StarvedWriteReport[]): void {
  for (const { query, field, write, laterWrites, readValue, decodedAtMs } of reports) {
    errorLog(
      "Inverter never applied ACKed writes to",
      `${query} ${field}:`,
      `it still reads ${readValue} ${Math.round((decodedAtMs - write.sentAtMs) / 1000)} s after the write of ${write.value}`,
      laterWrites ? `and ${laterWrites} later write(s) to it` : "",
      "— none showed in a readback while GS/PS polling continued; leaving any re-send to the owning control loop",
      "(paged once until the field moves)"
    );
  }
}

export function commitTimingRecord(
  tracked: TrackedSetter,
  verdict: CommitVerdict,
  nowMs: number,
  traffic: LineTraffic
): CommitTimingRecord {
  return {
    command: tracked.command,
    verdict,
    ackLatencyMs: Math.round(tracked.ackLatencyMs),
    ackAttempts: tracked.ackAttempts,
    ackToVerdictMs: Math.round(nowMs - tracked.ackedAtMs),
    readbacksStillOld: tracked.readbacksStillOld,
    lastStillOldAfterAckMs:
      tracked.lastStillOldAtMs === undefined ? null : Math.round(tracked.lastStillOldAtMs - tracked.ackedAtMs),
    pollRoundsBetween: traffic.pollRoundsCompleted - tracked.trafficAtAck.pollRoundsCompleted,
    framesBetween: traffic.framesWritten - tracked.trafficAtAck.framesWritten,
  };
}

function reportTrackedVerdict(
  tracker: SetterCommitTracker,
  command: string,
  verdict: CommitVerdict,
  nowMs: number,
  traffic: LineTraffic
): CommitTimingRecord[] {
  const tracked = tracker.get(command);
  // Every check comes from an ACKed send, and every ACKed send with a check is tracked
  if (!tracked) {
    warnLog("Inverter commit timing: no measurement for", command, "reaching verdict", verdict, "— not logged");
    return [];
  }
  return [reportVerdict(tracker, tracked, verdict, nowMs, traffic)];
}

function reportVerdict(
  tracker: SetterCommitTracker,
  tracked: TrackedSetter,
  verdict: CommitVerdict,
  nowMs: number,
  traffic: LineTraffic
): CommitTimingRecord {
  tracker.delete(tracked.command);
  const record = commitTimingRecord(tracked, verdict, nowMs, traffic);
  logLog("Inverter commit timing:", JSON.stringify(record));
  return record;
}

function commandsOf(checks: readonly PendingReadbackCheck[]): Set<string> {
  return new Set(checks.map(check => check.forCommand));
}

function describeChecks(checks: readonly PendingReadbackCheck[]): string {
  return checks.map(check => `${check.forCommand} → ${check.field}=${check.expectedValue}`).join(", ");
}
