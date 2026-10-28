/**
 * Reactive self-test of the buying setters (buyingSetterWiring.ts) under createRoot: what each tick
 * queues — above all that the window-end tick never queues EDB0, i.e. the hold is in force within that
 * tick (a hold lagging it by one microtask fails 12 of these checks) — plus the hall
 * freshness, the bounded MUCHGC/EDB0 re-asks and the settings readback requests. The harness keeps the
 * session's write chains with the real scheduler functions. The readback memos on their own:
 * acChargingReadbacks.selftest.ts. The same graph against the real scheduler and a modelled inverter:
 * buyingSetterSession.selftest.ts.
 * Run from backend/ with:  yarn node src/buying/buyingSetterWiring.selftest.ts
 */
import process from "process";
import { setOnErrorLog } from "../utilities/logging.ts";
import { freshHallAmps, HALL_READING_MAX_AGE_MS } from "./buyingSetterWiring.ts";
import { STEP_DOWN_EXTENSION_MS, STEP_DOWN_TIMEOUT_MS } from "./buyWindowEndStepDown.ts";
import { EDB0_RETRY_SPACING_MS } from "./buyWindowEndRelease.ts";
import {
  advanceTo,
  createWiringHarness,
  decodeBats,
  decodeHecs,
  queuedDuring,
  recordSend,
  runWithHall,
  type WiringHarness,
} from "./buyingSetterWiringHarness.ts";

const failedChecks: string[] = [];

{
  // The incident's window end through the real graph
  const harness = nightWindowAt261();
  const endTick = queuedDuring(harness, () => harness.setChargingAmperage(0));
  check(
    "window-end tick: MUCHGC0100 queued, EDB0 not",
    endTick.includes("MUCHGC0100") && !endTick.includes("EDB0"),
    endTick.join(" ")
  );
  check("…and the step-down holds", harness.wiring.holdsAcChargingOn());
  advanceTo(harness, 500);
  recordSend(harness, "MUCHGC0100");
  const beforeConfirm = runWithHall(harness, 750, 12_250, atMs => (atMs < 6_500 ? 280 : 11));
  check(
    "no EDB0 at any tick before the cap is confirmed (hall already 11 A)",
    !beforeConfirm.some(entry => entry.command === "EDB0")
  );
  advanceTo(harness, 12_500);
  const confirmTick = queuedDuring(harness, () => decodeBats(harness, 10));
  check(
    "BATS 10 A proving the cap's write landed, the hall settled → EDB0 queued in that tick",
    confirmTick.join(" ") === "EDB0",
    confirmTick.join(" ")
  );
  harness.dispose();
}

{
  // A window re-entered and ended again while stepping down
  const harness = nightWindowAt261();
  harness.setChargingAmperage(0);
  runWithHall(harness, 250, 3_000, () => 280);
  const reEntryTick = queuedDuring(harness, () => harness.setChargingAmperage(261));
  check(
    "re-entry tick: MUCHGC2610 + EDB1, no EDB0",
    reEntryTick.includes("MUCHGC2610") && reEntryTick.includes("EDB1") && !reEntryTick.includes("EDB0"),
    reEntryTick.join(" ")
  );
  runWithHall(harness, 3_250, 5_000, () => 280);
  const reEndTick = queuedDuring(harness, () => harness.setChargingAmperage(0));
  check(
    "re-end tick: MUCHGC0100, no EDB0",
    reEndTick.includes("MUCHGC0100") && !reEndTick.includes("EDB0"),
    reEndTick.join(" ")
  );
  harness.dispose();
}

{
  // The review's case B: a window that ends 5 s after it started, HECS still showing the pre-window "disabled"
  const harness = createWiringHarness({
    chargingAmperageForBuying: 0,
    acChargeBatteryState: "disabled",
    hallBatteryAmps: -3,
  });
  advanceTo(harness, -30_000);
  decodeHecs(harness, "disabled");
  decodeBats(harness, 10);
  advanceTo(harness, 0);
  const startTick = queuedDuring(harness, () => harness.setChargingAmperage(261));
  check("window start: EDB1 + MUCHGC2610", startTick.includes("EDB1") && startTick.includes("MUCHGC2610"));
  // The session sends both (exchanges done at 0.3 s and 0.6 s)
  advanceTo(harness, 300);
  recordSend(harness, "EDB1");
  advanceTo(harness, 600);
  recordSend(harness, "MUCHGC2610");
  runWithHall(harness, 750, 4_750, atMs => (atMs < 3_000 ? -3 : 150));
  const endTick = queuedDuring(harness, () => harness.setChargingAmperage(0));
  check(
    "window ends 5 s in → no EDB0 (and no EDB1 to 'hold' AC charging on the stale 'disabled')",
    !endTick.includes("EDB0") && !endTick.includes("EDB1") && harness.wiring.holdsAcChargingOn(),
    endTick.join(" ")
  );
  advanceTo(harness, 5_400);
  recordSend(harness, "MUCHGC0100");
  const untilConfirm = runWithHall(harness, 5_500, 17_250, atMs => (atMs < 11_400 ? 270 : 11));
  check("…none either until the cap is proven", !untilConfirm.some(entry => entry.command === "EDB0"));
  // 10 A after 10 → 261 → 10 can't tell whether MUCHGC2610 is still to land: the alternate cap settles it
  advanceTo(harness, 17_400);
  decodeHecs(harness, "enabled");
  const confirmTick = queuedDuring(harness, () => decodeBats(harness, 10));
  check(
    "…the cap's 10 A confirm can't rule out MUCHGC2610 → MUCHGC0090 queued, no EDB0",
    confirmTick.join(" ") === "MUCHGC0090",
    confirmTick.join(" ")
  );
  advanceTo(harness, 17_700);
  recordSend(harness, "MUCHGC0090");
  runWithHall(harness, 17_750, 29_500, atMs => (atMs < 23_700 ? 11 : 9));
  const alternateConfirmTick = queuedDuring(harness, () => decodeBats(harness, 9));
  check(
    "…its 9 A confirm proves every earlier write landed → EDB0, 24.7 s after the end",
    alternateConfirmTick.join(" ") === "EDB0",
    alternateConfirmTick.join(" ")
  );
  harness.dispose();
}

{
  // Hall freshness: a stale sample counts as no sample
  check(
    `freshHallAmps: fresh up to ${HALL_READING_MAX_AGE_MS / 1000} s, then undefined`,
    freshHallAmps({ value: 11, time: 1_000 }, 1_000 + HALL_READING_MAX_AGE_MS) === 11 &&
      freshHallAmps({ value: 11, time: 1_000 }, 1_001 + HALL_READING_MAX_AGE_MS) === undefined &&
      freshHallAmps(undefined, 1_000) === undefined
  );
  const harness = nightWindowAt261();
  harness.setChargingAmperage(0);
  runWithHall(harness, 250, 6_000, atMs => (atMs < 6_000 ? 280 : 11));
  advanceTo(harness, 500);
  recordSend(harness, "MUCHGC0100");
  // The hall stops updating after 6 s: by the confirm at 12.5 s its 11 A is stale
  for (let atMs = 6_250; atMs < 12_500; atMs += 250) advanceTo(harness, atMs);
  advanceTo(harness, 12_500);
  const confirmTick = queuedDuring(harness, () => decodeBats(harness, 10));
  check("stale hall: no EDB0 at the confirm", !confirmTick.includes("EDB0"));
  let edb0QueuedAtMs: number | undefined;
  for (let atMs = 12_750; atMs <= 16_000 && edb0QueuedAtMs === undefined; atMs += 250) {
    if (queuedDuring(harness, () => advanceTo(harness, atMs)).includes("EDB0")) edb0QueuedAtMs = atMs;
  }
  check(
    "…EDB0 after the readback + 3 s settle instead (released without hall)",
    edb0QueuedAtMs === 15_500,
    `${edb0QueuedAtMs}`
  );
  harness.dispose();
}

{
  // The review's restart probe: feedWhenNoSolar (and this graph) restarts after an error while the
  // session lives on. EDB1 went out at a window start 3 h ago, EDB0 at its end, both long read back: the
  // session's chains hold nothing unproven, the store says "disabled", and no HECS round comes for 125 s.
  const restartAtMs = 3 * 3_600_000;
  const restarted = createWiringHarness(
    { chargingAmperageForBuying: undefined, acChargeBatteryState: "disabled", hallBatteryAmps: -40 },
    {
      clock: { monotonicMs: restartAtMs },
      unprovenWrites: () => [],
      settingsReadbackAtMs: query => (query === "HECS" ? 3_627_500 : undefined),
    }
  );
  runWithHall(restarted, restartAtMs, restartAtMs + 125_000, () => -40);
  check(
    "graph restart, nothing unproven in the session's chains → no spurious step-down, no timeout",
    restarted.wiring.stepDownState().progress.phase === "idle" &&
      !restarted.queued.some(entry => entry.atMs > restartAtMs) &&
      restarted.readbackRequestsAtMs.length === 0,
    restarted.queued.map(entry => entry.command).join(" ")
  );
  restarted.dispose();
  // …but if an EDB1 the session hasn't read back yet went out 2 s before (a window had just started), the
  // "disabled" may be racing it: the step-down starts, as it should
  const freshEnable = createWiringHarness(
    { chargingAmperageForBuying: undefined, acChargeBatteryState: "disabled", hallBatteryAmps: 150 },
    {
      clock: { monotonicMs: restartAtMs },
      unprovenWrites: query =>
        query === "HECS"
          ? [{ value: "enabled", sentAtMs: restartAtMs - 2_000, acknowledged: true }]
          : [{ value: 261, sentAtMs: restartAtMs - 1_700, acknowledged: true }],
      settingsReadbackAtMs: query => (query === "HECS" ? restartAtMs - 30_000 : undefined),
    }
  );
  check(
    "graph restart 2 s after an EDB1 the session hasn't read back → the step-down holds",
    freshEnable.wiring.holdsAcChargingOn()
  );
  freshEnable.dispose();
}

{
  // A cap that commits after its confirm gave up: the hall shows it, BATS last read 261 A before it landed.
  // The graph asks the session for a settings readback once, and it proves the cap.
  const harness = nightWindowAt261();
  harness.setChargingAmperage(0);
  advanceTo(harness, 500);
  recordSend(harness, "MUCHGC0100");
  runWithHall(harness, 750, 42_250, () => 280);
  advanceTo(harness, 42_500);
  decodeBats(harness, 261);
  runWithHall(harness, 42_750, 50_000, atMs => (atMs < 47_000 ? 280 : 11));
  check(
    "cap landed after its last confirm: one settings readback asked for, 3 s into the hall's settle",
    harness.readbackRequestsAtMs.join() === "50000" && harness.wiring.holdsAcChargingOn(),
    harness.readbackRequestsAtMs.join()
  );
  runWithHall(harness, 50_250, 59_750, () => 11);
  check("…nothing more while it is open", harness.readbackRequestsAtMs.length === 1);
  advanceTo(harness, 60_000);
  const answerTick = queuedDuring(harness, () => decodeBats(harness, 10));
  check("…its answer proves the cap → EDB0", answerTick.join(" ") === "EDB0", answerTick.join(" "));
  harness.dispose();
}

{
  // The review's deadline-tick probe through the graph: no BATS for 120 s, then the deadline's own tick is
  // the one a fresh 261 A readback triggers — only the alternate cap may be queued in it
  const harness = createWiringHarness({
    chargingAmperageForBuying: 261,
    acChargeBatteryState: "enabled",
    hallBatteryAmps: 280,
  });
  decodeBats(harness, 261);
  advanceTo(harness, 0);
  harness.setChargingAmperage(0);
  runWithHall(harness, 250, STEP_DOWN_TIMEOUT_MS - 250, () => 280);
  harness.clock.monotonicMs = STEP_DOWN_TIMEOUT_MS;
  const deadlineTick = queuedDuring(harness, () => decodeBats(harness, 261));
  check(
    "deadline tick: only MUCHGC0090 queued — no MUCHGC0100 after it to replace it in the session queue",
    deadlineTick.join(" ") === "MUCHGC0090",
    deadlineTick.join(" ")
  );

  // MUCHGC0090 has never been sent to the real inverter: if its firmware NAKs a limit below 10 A, the item's
  // onResult re-asserts MUCHGC0100 (with a warnLog); an ACK adds nothing
  const alternateCapItem = harness.queued.filter(entry => entry.command === "MUCHGC0090").at(-1)?.item;
  const afterAck = queuedDuring(harness, () => alternateCapItem?.onResult?.({ acknowledged: true }));
  check("alternate cap ACKed → nothing more queued", alternateCapItem !== undefined && afterAck.length === 0);
  const warnings: string[] = [];
  const afterNak = queuedDuring(harness, () =>
    withWarningsCaptured(warnings, () => alternateCapItem?.onResult?.({ acknowledged: false }))
  );
  check(
    "alternate cap NAKed → MUCHGC0100 re-asserted, with a warnLog",
    afterNak.join(" ") === "MUCHGC0100" && warnings.some(text => text.includes("rejected the 9 A alternate cap")),
    `${afterNak.join(" ")} | ${warnings.join(" | ")}`
  );
  harness.dispose();
}

{
  // The bounded re-asks: a cap the inverter never applies, then an EDB0 it never applies
  const reportedErrors: string[] = [];
  setOnErrorLog(args => reportedErrors.push(args.join(" ")));
  const harness = nightWindowAt261();
  harness.setChargingAmperage(0);
  runWithHall(harness, 250, 12_250, () => 280);
  advanceTo(harness, 12_500);
  check(
    "BATS still 261 A → MUCHGC0100 re-queued once",
    queuedDuring(harness, () => decodeBats(harness, 261)).join(" ") === "MUCHGC0100"
  );
  advanceTo(harness, 42_500);
  check("…a second 261 A readback queues nothing", queuedDuring(harness, () => decodeBats(harness, 261)).length === 0);
  // The hall still at 280 A at the timeout: the cap is demonstrably not in effect → hold on, page, and
  // send the cap again as MUCHGC0090 at once
  const untilTimeout = runWithHall(harness, 42_750, STEP_DOWN_TIMEOUT_MS + 2_000, () => 280);
  check(
    "…the timeout with the hall at 280 A queues the alternate cap, not EDB0: the hold is extended, and it pages",
    untilTimeout.map(entry => `${entry.command}@${entry.atMs}`).join(" ") === `MUCHGC0090@${STEP_DOWN_TIMEOUT_MS}` &&
      harness.wiring.holdsAcChargingOn() &&
      reportedErrors.filter(text => text.includes("the 10 A cap is not in effect")).length === 1,
    untilTimeout.map(entry => `${entry.command}@${entry.atMs}`).join(" ")
  );
  advanceTo(harness, 150_000);
  check(
    "…a 261 A readback in the extension queues nothing (MUCHGC0100 would replace the alternate cap)",
    queuedDuring(harness, () => decodeBats(harness, 261)).length === 0
  );
  const extendedDeadlineMs = STEP_DOWN_TIMEOUT_MS + STEP_DOWN_EXTENSION_MS;
  const untilExtendedDeadline = runWithHall(harness, 150_250, extendedDeadlineMs + 2_000, () => 280);
  check(
    "…EDB0 only at the extended deadline, paging that it stops full current",
    untilExtendedDeadline.map(entry => `${entry.command}@${entry.atMs}`).join(" ") === `EDB0@${extendedDeadlineMs}` &&
      reportedErrors.filter(text => text.includes("one-step stop at full current")).length === 1,
    untilExtendedDeadline.map(entry => `${entry.command}@${entry.atMs}`).join(" ")
  );
  advanceTo(harness, 200_000);
  check(
    "…readbacks after the release queue no MUCHGC",
    queuedDuring(harness, () => decodeBats(harness, 261)).length === 0
  );
  // EDB0 ACKed but never applied: HECS keeps showing "enabled" on the settings poll
  const edb0Requests: number[] = [];
  for (const atMs of [400_000, 580_000, 760_000, 940_000]) {
    advanceTo(harness, atMs);
    if (queuedDuring(harness, () => decodeHecs(harness, "enabled")).includes("EDB0")) edb0Requests.push(atMs);
  }
  check(
    `EDB0 re-queued at most twice, ≥ ${EDB0_RETRY_SPACING_MS / 1000} s apart`,
    edb0Requests.join() === "400000,580000",
    edb0Requests.join()
  );
  const exhausted = reportedErrors.filter(text => text.includes("EDB0 still not applied"));
  check(
    "…then one errorLog, not a retry loop — naming the last read-back limit, not the cap",
    exhausted.length === 1 && exhausted[0]!.includes("last read-back limit of 261.0 A"),
    exhausted.join(" | ")
  );
  setOnErrorLog(undefined);
  harness.dispose();

  // In a window (no step-down) a MUCHGC target BATS never shows is not re-sent by the buying module
  const inWindow = nightWindowAt261();
  const inWindowRequeues: string[] = [];
  for (const atMs of [12_500, 42_500, 180_000, 360_000]) {
    advanceTo(inWindow, atMs);
    inWindowRequeues.push(...queuedDuring(inWindow, () => decodeBats(inWindow, 10)));
  }
  check(
    "in-window readbacks that don't show the target re-queue nothing",
    inWindowRequeues.length === 0,
    inWindowRequeues.join(" ")
  );
  inWindow.dispose();
}

if (failedChecks.length) {
  console.error(`\n${failedChecks.length} check(s) FAILED:`, failedChecks.join("; "));
  process.exit(1);
}
console.log("\nAll buying setter wiring checks passed");

function check(name: string, condition: boolean, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}: ${name} ${detail}`);
  if (!condition) failedChecks.push(name);
}

/** Runs `action` with console.warn (where warnLog prints) collected into `warnings` */
function withWarningsCaptured(warnings: string[], action: () => void): void {
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
  try {
    action();
  } finally {
    console.warn = originalWarn;
  }
}

/** A night window charging at 261 A for a while, its readbacks long confirmed, the clock at 0 */
function nightWindowAt261(): WiringHarness {
  const harness = createWiringHarness({
    chargingAmperageForBuying: 261,
    acChargeBatteryState: "enabled",
    hallBatteryAmps: 280,
  });
  advanceTo(harness, -600_000);
  recordSend(harness, "EDB1");
  recordSend(harness, "MUCHGC2610");
  decodeHecs(harness, "enabled");
  decodeBats(harness, 261);
  runWithHall(harness, -60_000, 0, () => 280);
  return harness;
}
