/**
 * Pure self-test of the per-setter commit measurement (#52): ACK latency, ACK → verdict, the
 * readbacks that still showed the old value, and the traffic in between — with the scheduler's
 * real confirm transitions feeding it. Run from backend/ with:
 *   yarn node src/inverterComms/setterCommitTiming.selftest.ts
 */
import process from "process";
import { afterConfirmRun, afterSetterSent, initialSchedulerState, type SchedulerState } from "./schedulerCore.ts";
import {
  reportAckedSetter,
  reportConfirmOutcome,
  type CommitTimingRecord,
  type LineTraffic,
  type SetterCommitTracker,
} from "./setterCommitTiming.ts";

const fails: string[] = [];
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name} ${detail}`);
  if (!cond) fails.push(name);
}

const seconds = (value: number) => value * 1000;
const gpmp = (watts: number) => ({ GPMP: { maximum_feeding_grid_power: watts } });
const traffic = (pollRoundsCompleted: number, framesWritten: number): LineTraffic => ({
  pollRoundsCompleted,
  framesWritten,
});

// ---------- gap 0: still old twice, then confirmed ----------
{
  const tracker: SetterCommitTracker = new Map();
  let state = ackedWrite(initialSchedulerState({ quietGapAfterWriteMs: 0 }), tracker, "GPMP000550", seconds(10), 0);
  check("an ACKed setter with a readback check is tracked", tracker.has("GPMP000550"));
  const stillOldRecords = [seconds(16), seconds(20)].flatMap(confirmAtMs => {
    const confirmRun = afterConfirmRun(state, gpmp(350), confirmAtMs);
    state = confirmRun.state;
    return reportConfirmOutcome(tracker, confirmRun.result, "interleaved", confirmAtMs, traffic(9, 21));
  });
  check(
    "still-old runs report no verdict and count the old readbacks",
    stillOldRecords.length === 0 && tracker.get("GPMP000550")?.readbacksStillOld === 2
  );
  const confirmRun = afterConfirmRun(state, gpmp(550), seconds(24.2));
  const [record] = reportConfirmOutcome(tracker, confirmRun.result, "interleaved", seconds(24.2), traffic(14, 33));
  check(
    "the confirming run logs one timing record with ACK latency, ACK → confirmed and the traffic in between",
    record?.verdict === "confirmed" &&
      record.command === "GPMP000550" &&
      record.quietGapAfterWriteMs === 0 &&
      record.ackLatencyMs === 87 &&
      record.ackAttempts === 1 &&
      record.ackToVerdictMs === 14_200 &&
      record.readbacksStillOld === 2 &&
      record.lastStillOldAfterAckMs === 10_000 &&
      record.pollRoundsBetween === 12 &&
      record.framesBetween === 28,
    JSON.stringify(record)
  );
  check("…and the measurement ends there", tracker.size === 0);
}

// ---------- the default strategy: confirmed on the first readback, nothing in between ----------
{
  const tracker: SetterCommitTracker = new Map();
  const state = ackedWrite(initialSchedulerState(), tracker, "GPMP000350", seconds(10), 0);
  const confirmRun = afterConfirmRun(state, gpmp(350), seconds(22.1));
  const [record] = reportConfirmOutcome(tracker, confirmRun.result, "silent", seconds(22.1), traffic(2, 6));
  check(
    "silent: confirmed after the 12 s gap with no poll round and one confirm frame in between",
    record?.verdict === "confirmed" &&
      record.quietGapAfterWriteMs === 12_000 &&
      record.ackToVerdictMs === 12_100 &&
      record.readbacksStillOld === 0 &&
      record.lastStillOldAfterAckMs === null &&
      record.pollRoundsBetween === 0 &&
      record.framesBetween === 1,
    JSON.stringify(record)
  );
}

// ---------- give-up, supersede, identical rewrite, multi-field setters ----------
{
  const tracker: SetterCommitTracker = new Map();
  let state = ackedWrite(initialSchedulerState({ quietGapAfterWriteMs: 0 }), tracker, "GPMP000550", seconds(0), 0);
  const recordsBeforeDeadline: CommitTimingRecord[] = [];
  for (let confirmAtSeconds = 6; confirmAtSeconds < 55; confirmAtSeconds += 4) {
    const confirmRun = afterConfirmRun(state, gpmp(350), seconds(confirmAtSeconds));
    state = confirmRun.state;
    recordsBeforeDeadline.push(
      ...reportConfirmOutcome(tracker, confirmRun.result, "interleaved", seconds(confirmAtSeconds), traffic(40, 90))
    );
  }
  const finalRun = afterConfirmRun(state, gpmp(350), seconds(55));
  const records = reportConfirmOutcome(tracker, finalRun.result, "interleaved", seconds(55), traffic(44, 99));
  check(
    "a write that never shows up gets a never_applied record at its deadline, and none before",
    recordsBeforeDeadline.length === 0 &&
      records.length === 1 &&
      records[0]!.verdict === "never_applied" &&
      records[0]!.ackToVerdictMs === 55_000 &&
      records[0]!.readbacksStillOld === 13,
    JSON.stringify(records)
  );
}
{
  const tracker: SetterCommitTracker = new Map();
  let state = ackedWrite(initialSchedulerState({ quietGapAfterWriteMs: 0 }), tracker, "GPMP000550", seconds(0), 0);
  state = afterSetterSent(state, "GPMP000350", ["GPMP"], seconds(3), true);
  const superseded = reportAckedSetter(
    tracker,
    { command: "GPMP000350", quietGapAfterWriteMs: 0, ackLatencyMs: 90, ackAttempts: 1, ackedAtMs: seconds(3) },
    state.confirm,
    traffic(3, 8)
  );
  check(
    "a newer write to the same field supersedes the older measurement",
    superseded.length === 1 &&
      superseded[0]!.command === "GPMP000550" &&
      superseded[0]!.verdict === "superseded" &&
      tracker.size === 1 &&
      tracker.has("GPMP000350")
  );
  state = afterSetterSent(state, "GPMP000350", ["GPMP"], seconds(63), true);
  const rewritten = reportAckedSetter(
    tracker,
    { command: "GPMP000350", quietGapAfterWriteMs: 0, ackLatencyMs: 2_400, ackAttempts: 2, ackedAtMs: seconds(63) },
    state.confirm,
    traffic(50, 120)
  );
  check(
    "an identical rewrite ends the older measurement and starts a fresh one",
    rewritten.length === 1 &&
      rewritten[0]!.ackToVerdictMs === 60_000 &&
      tracker.get("GPMP000350")?.ackedAtMs === seconds(63) &&
      tracker.get("GPMP000350")?.ackAttempts === 2
  );
}
{
  const tracker: SetterCommitTracker = new Map();
  let state = ackedWrite(initialSchedulerState({ quietGapAfterWriteMs: 0 }), tracker, "MCHGV0570,0570", seconds(0), 0);
  const floatStillOld = { BATS: { "battery_constant_charge_voltage(c.v.)": 57, battery_floating_charge_voltage: 58 } };
  const firstRun = afterConfirmRun(state, floatStillOld, seconds(6));
  state = firstRun.state;
  const partial = reportConfirmOutcome(tracker, firstRun.result, "interleaved", seconds(6), traffic(5, 12));
  check(
    "MCHGV: CV visible but float still old → no verdict yet",
    partial.length === 0 && tracker.get("MCHGV0570,0570")?.readbacksStillOld === 1
  );
  const bothApplied = { BATS: { "battery_constant_charge_voltage(c.v.)": 57, battery_floating_charge_voltage: 57 } };
  const secondRun = afterConfirmRun(state, bothApplied, seconds(10));
  const [record] = reportConfirmOutcome(tracker, secondRun.result, "interleaved", seconds(10), traffic(8, 19));
  check(
    "MCHGV: confirmed once both fields show — one record for the command",
    record?.verdict === "confirmed" && record.command === "MCHGV0570,0570" && tracker.size === 0
  );
}
{
  const tracker: SetterCommitTracker = new Map();
  const state = afterSetterSent(initialSchedulerState(), "DAT261025120000", [], seconds(1), true);
  reportAckedSetter(
    tracker,
    {
      command: "DAT261025120000",
      quietGapAfterWriteMs: 12_000,
      ackLatencyMs: 80,
      ackAttempts: 1,
      ackedAtMs: seconds(1),
    },
    state.confirm,
    traffic(0, 0)
  );
  check("a setter without a readback check is not tracked (it can never reach a verdict)", tracker.size === 0);
}

console.log(
  `\n${fails.length ? `${fails.length} FAILED: ${fails.join(", ")}` : "all setterCommitTiming selftests passed"}`
);
process.exit(fails.length ? 1 : 0);

/** What sendQueuedSetter does on an ACK: arm the confirm phase, then start the measurement */
function ackedWrite(
  state: SchedulerState,
  tracker: SetterCommitTracker,
  command: string,
  ackedAtMs: number,
  framesWrittenAtAck: number
): SchedulerState {
  const armed = afterSetterSent(state, command, ["GPMP"], ackedAtMs, true);
  reportAckedSetter(
    tracker,
    {
      command,
      quietGapAfterWriteMs: armed.timing.quietGapAfterWriteMs,
      ackLatencyMs: 87.4,
      ackAttempts: 1,
      ackedAtMs,
    },
    armed.confirm,
    traffic(2, framesWrittenAtAck + 5)
  );
  return armed;
}
