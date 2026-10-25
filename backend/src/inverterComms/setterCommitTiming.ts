/**
 * Per-setter commit measurement and the confirm-verdict log lines, so the quiet-gap experiment
 * (#52) can be read straight from the log: how long the inverter took to ACK, how long from the
 * ACK until a readback showed the write applied, and how much traffic went over the line in
 * between (an ACK is frame-level only — the commit lands seconds later, if traffic lets it).
 *
 * Every setter with a readback check gets exactly one "Inverter commit timing:" JSON line, at its
 * verdict: confirmed, never_applied (the loud give-up) or superseded (a newer write to the same
 * field replaced its check first). Times are the session's monotonic clock.
 */
import { debugLog, errorLog, logLog, warnLog } from "../utilities/logging.ts";
import type { ConfirmOutcome, ConfirmPhase, PendingReadbackCheck } from "./schedulerCore.ts";
import type { ConfirmStrategy } from "./schedulerTiming.ts";

/** Cumulative line traffic, sampled at the ACK and again at the verdict */
export type LineTraffic = { pollRoundsCompleted: number; framesWritten: number };

export type TrackedSetter = {
  command: string;
  quietGapAfterWriteMs: number;
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
  quietGapAfterWriteMs: number;
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
  const { command, quietGapAfterWriteMs, ackLatencyMs, ackAttempts, ackedAtMs } = setter;
  logLog(
    "Inverter ACKed",
    command,
    `in ${Math.round(ackLatencyMs)} ms${ackAttempts > 1 ? " (on the retry)" : ""}`,
    quietGapAfterWriteMs > 0
      ? `— confirming the commit by readback after the ${quietGapAfterWriteMs} ms quiet gap`
      : "— confirming the commit by readback with polling continuing (quiet gap 0)"
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
  outcome: ConfirmOutcome,
  strategy: ConfirmStrategy,
  nowMs: number,
  traffic: LineTraffic
): CommitTimingRecord[] {
  const { confirmedChecks, gaveUpChecks, retry } = outcome;
  if (confirmedChecks.length) logLog("Inverter write(s) confirmed applied:", describeChecks(confirmedChecks));
  if (gaveUpChecks.length) {
    errorLog(
      strategy === "silent"
        ? "Inverter ACKed but never applied within quiet gap + backoff:"
        : "Inverter ACKed but never applied within the interleaved confirm window:",
      gaveUpChecks.map(check => `${check.forCommand} (wanted ${check.field}=${check.expectedValue})`).join(", "),
      "— leaving any re-send to the owning control loop (rate-limited by the 60 s identical-setter gate)"
    );
  }
  const stillPending = commandsOf(retry?.pendingChecks ?? []);
  if (retry) {
    const stillOldCommands = [...stillPending].join(", ");
    if (strategy === "silent") {
      warnLog("Inverter write(s) not visible in readback yet — re-checking after quiet backoff:", stillOldCommands);
    } else {
      debugLog(
        "Inverter write(s) not visible in readback yet — re-checking in",
        Math.round(retry.retryAt - nowMs),
        "ms with polling continuing:",
        stillOldCommands
      );
    }
  }

  const neverApplied = commandsOf(gaveUpChecks);
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
  for (const command of stillPending) {
    const tracked = tracker.get(command);
    if (tracked) {
      tracker.set(command, { ...tracked, readbacksStillOld: tracked.readbacksStillOld + 1, lastStillOldAtMs: nowMs });
    }
  }
  return records;
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
    quietGapAfterWriteMs: tracked.quietGapAfterWriteMs,
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
