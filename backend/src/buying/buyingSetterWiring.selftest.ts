/**
 * Reactive self-test of the buying setters (buyingSetterWiring.ts) under createRoot: what each tick
 * queues — above all that the window-end tick never queues EDB0, i.e. the hold is in force within that
 * tick (a hold lagging it by one microtask fails 8 of these checks) — plus the hall freshness and readback
 * memos and the bounded MUCHGC/EDB0 re-asks. The same graph against #48's real scheduler:
 * buyingSetterSession.selftest.ts.
 * Run from backend/ with:  yarn node src/buying/buyingSetterWiring.selftest.ts
 */
import process from "process";
import { createRoot, createSignal } from "solid-js";
import type { DecodedRound } from "../inverterComms/pi17Protocol.types.ts";
import type { UsbValues } from "../inverterComms/inverterComms.types.ts";
import { setOnErrorLog } from "../utilities/logging.ts";
import { createAcChargingReadbacks } from "./acChargingReadbacks.ts";
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
  const beforeConfirm = runWithHall(harness, 250, 12_250, atMs => (atMs < 6_000 ? 280 : 11));
  check(
    "no EDB0 at any tick before the cap is confirmed (hall already 11 A)",
    !beforeConfirm.some(entry => entry.command === "EDB0")
  );
  advanceTo(harness, 12_500);
  const confirmTick = queuedDuring(harness, () => decodeBats(harness, 10));
  check(
    "BATS 10 A with the hall settled → EDB0 queued in that tick",
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
  const untilConfirm = runWithHall(harness, 5_250, 17_250, atMs => (atMs < 11_000 ? 270 : 11));
  check("…none either until the cap is proven", !untilConfirm.some(entry => entry.command === "EDB0"));
  advanceTo(harness, 17_400);
  decodeHecs(harness, "enabled");
  const confirmTick = queuedDuring(harness, () => decodeBats(harness, 10));
  check("…EDB0 at the confirm 12.4 s after the end", confirmTick.join(" ") === "EDB0", confirmTick.join(" "));
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
  // The readback memos on their own
  createRoot(dispose => {
    const [lastDecodedRound, setLastDecodedRound] = createSignal<DecodedRound | undefined>(undefined);
    const [acChargeBatteryState, setAcChargeBatteryState] = createSignal<UsbValues["ac_charge_battery"]>("enabled");
    let nowMs = 0;
    const { acChargingLimitReadback, acChargingReading } = createAcChargingReadbacks({
      lastDecodedRound,
      acChargeBatteryState,
      monotonicNowMs: () => nowMs,
    });
    check("BATS memo: nothing before a BATS round", acChargingLimitReadback() === undefined);
    check(
      "HECS reading: state from the store, time unknown (-Infinity) before any HECS round",
      acChargingReading()?.state === "enabled" && acChargingReading()?.observedAtMs === -Infinity
    );
    nowMs = 1_000;
    setLastDecodedRound({ command: "BATS", fields: { "max._ac_charging_current": 261 }, decodedAt: 0 });
    const first = acChargingLimitReadback();
    check("BATS memo: amps + the monotonic time it was observed", first?.amps === 261 && first.observedAtMs === 1_000);
    nowMs = 2_000;
    setLastDecodedRound({ command: "GS", fields: { battery_voltage: 55 }, decodedAt: 0 });
    check("BATS memo: a GS round keeps the very same readback", acChargingLimitReadback() === first);
    setLastDecodedRound({ command: "BATS", fields: { "max._ac_charging_current": "garbled" }, decodedAt: 0 });
    check("BATS memo: a non-numeric limit keeps the previous one (and warns)", acChargingLimitReadback() === first);
    nowMs = 3_000;
    setLastDecodedRound({ command: "HECS", fields: { ac_charge_battery: "enabled" }, decodedAt: 0 });
    check("HECS reading: stamped by a HECS round", acChargingReading()?.observedAtMs === 3_000);
    nowMs = 4_000;
    setLastDecodedRound({ command: "HECS", fields: { feed_power_to_utility: "enabled" }, decodedAt: 0 });
    check(
      "HECS reading: a HECS round without the flag doesn't restamp it",
      acChargingReading()?.observedAtMs === 3_000
    );
    setAcChargeBatteryState("disabled");
    check("HECS reading: follows the store's state", acChargingReading()?.state === "disabled");
    dispose();
  });
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
  // The hall still at 280 A at the timeout: the cap is demonstrably not in effect → hold on, page
  const untilTimeout = runWithHall(harness, 42_750, STEP_DOWN_TIMEOUT_MS + 2_000, () => 280);
  check(
    "…the timeout with the hall at 280 A queues no EDB0: the hold is extended, and it pages",
    untilTimeout.length === 0 &&
      harness.wiring.holdsAcChargingOn() &&
      reportedErrors.filter(text => text.includes("the 10 A cap is not in effect")).length === 1,
    untilTimeout.map(entry => `${entry.command}@${entry.atMs}`).join(" ")
  );
  advanceTo(harness, 180_000);
  check(
    "…the extension's 261 A readback re-asserts the cap once more",
    queuedDuring(harness, () => decodeBats(harness, 261)).join(" ") === "MUCHGC0100"
  );
  advanceTo(harness, 200_000);
  check("…and only once", queuedDuring(harness, () => decodeBats(harness, 261)).length === 0);
  const extendedDeadlineMs = STEP_DOWN_TIMEOUT_MS + STEP_DOWN_EXTENSION_MS;
  const untilExtendedDeadline = runWithHall(harness, 200_250, extendedDeadlineMs + 2_000, () => 280);
  check(
    "…EDB0 only at the extended deadline, paging that it stops full current",
    untilExtendedDeadline.map(entry => `${entry.command}@${entry.atMs}`).join(" ") === `EDB0@${extendedDeadlineMs}` &&
      reportedErrors.filter(text => text.includes("one-step stop at full current")).length === 1,
    untilExtendedDeadline.map(entry => `${entry.command}@${entry.atMs}`).join(" ")
  );
  advanceTo(harness, 320_000);
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
