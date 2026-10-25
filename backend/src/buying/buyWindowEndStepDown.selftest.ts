/**
 * Pure self-test of the buy-window end step-down, main paths: EDB0 only once the 10 A cap has really
 * taken effect — at night, with PV, when the confirm gives up, without a hall sensor, and the timeout.
 * Window extensions, shrinks, new windows, restarts and readback races: buyWindowEndStepDownEdgeCases.selftest.ts.
 * Run from backend/ with:  yarn node src/buying/buyWindowEndStepDown.selftest.ts
 */
import process from "process";
import {
  allowedHallAmps,
  type BuyWindowEndInputs,
  HALL_ALLOWANCE_ABOVE_IDLE_LIMIT_AMPS,
  holdsAcChargingOn,
  IDLE_AC_CHARGING_LIMIT_AMPS,
  initialBuyWindowEndStepDownState,
  SETTLED_FOR_MS,
  STEP_DOWN_TIMEOUT_MS,
  wantedAcChargingLimitAmps,
} from "./buyWindowEndStepDown.ts";
import {
  buyingFor,
  COMMIT_AFTER_WRITE_MS,
  CONFIRM_AFTER_WRITE_MS,
  eventsAfter,
  heldAtAnyStep,
  holdsAtEveryStep,
  kindsAt,
  lastEvent,
  nightBuying,
  stepAt,
  windowEnd,
} from "./buyWindowEndStepDownSimulation.ts";

const failedChecks: string[] = [];

check("constants: idle cap is MUCHGC0100's 10 A", IDLE_AC_CHARGING_LIMIT_AMPS === 10);
check("constants: timeout ~2 min", STEP_DOWN_TIMEOUT_MS === 120_000);
check(
  "MUCHGC target: the window's amps while buying, the idle cap otherwise",
  wantedAcChargingLimitAmps(true, 261) === 261 &&
    wantedAcChargingLimitAmps(false, 261) === 10 &&
    wantedAcChargingLimitAmps(true, undefined) === 10 &&
    wantedAcChargingLimitAmps(false, undefined) === 10
);
check(
  "hall allowance: cap + margin at night, plus PV/V with sun",
  allowedHallAmps({ solarWatts: 0, batteryVoltage: 55 }) === 10 + HALL_ALLOWANCE_ABOVE_IDLE_LIMIT_AMPS &&
    allowedHallAmps({ solarWatts: 5400, batteryVoltage: 54 }) === 10 + HALL_ALLOWANCE_ABOVE_IDLE_LIMIT_AMPS + 100 &&
    allowedHallAmps({ solarWatts: 5400, batteryVoltage: undefined }) === 30 &&
    allowedHallAmps({ solarWatts: undefined, batteryVoltage: 54 }) === 30
);
check("a fresh state holds nothing", !holdsAcChargingOn(initialBuyWindowEndStepDownState()));

{
  // The incident's window end, done in two steps: hall 280 A until MUCHGC0100 commits, BATS confirms 10 A
  const simulation = buyingFor(nightBuying);
  stepAt(simulation, 0, windowEnd);
  check("window end: the step-down starts at once", kindsAt(simulation, 0).join() === "started");
  check("window end: AC charging is held on (EDB0 held back) in the same step", holdsAcChargingOn(simulation.state));
  const holdsUntilConfirm = holdsAtEveryStep(simulation, 250, CONFIRM_AFTER_WRITE_MS - 250, atMs => ({
    hallBatteryAmps: atMs < COMMIT_AFTER_WRITE_MS ? 280 : 11,
  }));
  check("hall already at 11 A for 6 s but no BATS proof yet → still holding", holdsUntilConfirm);
  stepAt(simulation, CONFIRM_AFTER_WRITE_MS, { limitReadback: { amps: 10, observedAtMs: CONFIRM_AFTER_WRITE_MS } });
  check(
    "BATS 10 A with the hall settled for 6.5 s → confirmed and released in the same step",
    kindsAt(simulation, CONFIRM_AFTER_WRITE_MS).join() === "limit_confirmed,released" &&
      !holdsAcChargingOn(simulation.state)
  );
  const released = lastEvent(simulation, "released");
  check(
    "…with the timings logged",
    released?.afterMs === CONFIRM_AFTER_WRITE_MS &&
      released.limitConfirmedAfterMs === CONFIRM_AFTER_WRITE_MS &&
      released.hallSettledForMs === CONFIRM_AFTER_WRITE_MS - COMMIT_AFTER_WRITE_MS &&
      released.allowedHallAmps === 30,
    JSON.stringify(released)
  );
  // EDB0 goes out; its HECS confirm lands after the next quiet gap. Until then HECS still says "enabled".
  const heldOnStaleHecs = heldAtAnyStep(simulation, 13_000, 25_000, () => ({ hallBatteryAmps: 0 }));
  check(
    "the stale HECS 'enabled' before EDB0's confirm doesn't start another step-down",
    !heldOnStaleHecs && simulation.state.progress.phase === "released" && eventsAfter(simulation, 12_600).length === 0
  );
  stepAt(simulation, 25_500, { acChargingReadback: "disabled" });
  const disabledConfirmed = lastEvent(simulation, "ac_charging_disabled_confirmed");
  check(
    "HECS shows AC charging off → back to idle, logged with timings",
    simulation.state.progress.phase === "idle" &&
      disabledConfirmed?.afterMs === 25_500 &&
      disabledConfirmed.afterReleaseMs === 25_500 - CONFIRM_AFTER_WRITE_MS
  );
  stepAt(simulation, 30_000, {});
  check("idle with AC charging off stays idle", simulation.state.progress.phase === "idle");
}

{
  // The cap "commits" per BATS but the battery keeps taking 280 A: never release on the readback alone
  const simulation = buyingFor(nightBuying);
  stepAt(simulation, 0, windowEnd);
  stepAt(simulation, CONFIRM_AFTER_WRITE_MS, { limitReadback: { amps: 10, observedAtMs: CONFIRM_AFTER_WRITE_MS } });
  const heldUntilTimeout = holdsAtEveryStep(simulation, 13_000, STEP_DOWN_TIMEOUT_MS - 1, () => ({}));
  check("hall stuck at 280 A with BATS at 10 A → held right up to the timeout", heldUntilTimeout);
  stepAt(simulation, STEP_DOWN_TIMEOUT_MS, {});
  const timedOut = lastEvent(simulation, "timed_out");
  check(
    "…then the timeout releases EDB0 anyway, reporting what was missing",
    !holdsAcChargingOn(simulation.state) &&
      timedOut?.afterMs === STEP_DOWN_TIMEOUT_MS &&
      timedOut.limitConfirmedAfterMs === CONFIRM_AFTER_WRITE_MS &&
      timedOut.hallBatteryAmps === 280 &&
      timedOut.allowedHallAmps === 30,
    JSON.stringify(timedOut)
  );
}

{
  // Daytime: 6 kW of PV keeps the battery charging at ~120 A after the cap — must not deadlock
  const sunnyBuying: BuyWindowEndInputs = {
    ...nightBuying,
    solarWatts: 6_000,
    batteryVoltage: 54,
    hallBatteryAmps: 380,
  };
  const simulation = buyingFor(sunnyBuying);
  stepAt(simulation, 0, windowEnd);
  holdsAtEveryStep(simulation, 250, CONFIRM_AFTER_WRITE_MS - 250, atMs => ({
    hallBatteryAmps: atMs < COMMIT_AFTER_WRITE_MS ? 380 : 120,
  }));
  stepAt(simulation, CONFIRM_AFTER_WRITE_MS, { limitReadback: { amps: 10, observedAtMs: CONFIRM_AFTER_WRITE_MS } });
  check(
    "6 kW PV, hall 120 A (≤ 10 + 20 + 111 A) → released at the BATS confirm like at night",
    lastEvent(simulation, "released")?.afterMs === CONFIRM_AFTER_WRITE_MS
  );
  // The same hall without the PV term in the allowance would wait for the timeout
  const simulationWithoutPv = buyingFor({ ...sunnyBuying, solarWatts: 0 });
  stepAt(simulationWithoutPv, 0, windowEnd);
  holdsAtEveryStep(simulationWithoutPv, 250, CONFIRM_AFTER_WRITE_MS - 250, atMs => ({
    hallBatteryAmps: atMs < COMMIT_AFTER_WRITE_MS ? 380 : 120,
  }));
  stepAt(simulationWithoutPv, CONFIRM_AFTER_WRITE_MS, {
    limitReadback: { amps: 10, observedAtMs: CONFIRM_AFTER_WRITE_MS },
  });
  check(
    "…(control: the same 120 A with PV unaccounted would still hold)",
    holdsAcChargingOn(simulationWithoutPv.state)
  );
}

{
  // The session's MUCHGC0100 confirm gives up (readback still 261 A at +12.5 s and +42.5 s); the buying
  // module re-queues the target on every BATS readback, so it goes out again at +60.5 s
  const simulation = buyingFor(nightBuying);
  stepAt(simulation, 0, windowEnd);
  stepAt(simulation, CONFIRM_AFTER_WRITE_MS, { limitReadback: { amps: 261, observedAtMs: CONFIRM_AFTER_WRITE_MS } });
  stepAt(simulation, 42_500, { limitReadback: { amps: 261, observedAtMs: 42_500 } });
  const heldThroughGiveUp = holdsAtEveryStep(simulation, 42_750, 72_000, atMs => ({
    hallBatteryAmps: atMs < 60_500 + COMMIT_AFTER_WRITE_MS ? 280 : 12,
  }));
  check("confirm gave up, limit still 261 A → held", heldThroughGiveUp);
  stepAt(simulation, 72_500, { limitReadback: { amps: 10, observedAtMs: 72_500 } });
  check(
    "…the re-sent MUCHGC0100 confirms at +72.5 s → released then, inside the timeout",
    lastEvent(simulation, "released")?.afterMs === 72_500
  );
  const neverApplied = buyingFor(nightBuying);
  stepAt(neverApplied, 0, windowEnd);
  stepAt(neverApplied, CONFIRM_AFTER_WRITE_MS, { limitReadback: { amps: 261, observedAtMs: CONFIRM_AFTER_WRITE_MS } });
  const heldWhileNeverApplied = holdsAtEveryStep(neverApplied, 13_000, STEP_DOWN_TIMEOUT_MS - 1, () => ({}));
  stepAt(neverApplied, STEP_DOWN_TIMEOUT_MS, {});
  const timedOut = lastEvent(neverApplied, "timed_out");
  check(
    "a cap that never applies → held for 2 min, then released with the unconfirmed readback reported",
    heldWhileNeverApplied &&
      !holdsAcChargingOn(neverApplied.state) &&
      timedOut !== undefined &&
      timedOut.limitConfirmedAfterMs === undefined &&
      timedOut.limitReadback?.amps === 261
  );
}

{
  // current_measuring disabled or erroring: the readback plus the settle time decide
  const simulation = buyingFor({ ...nightBuying, hallBatteryAmps: undefined });
  stepAt(simulation, 0, windowEnd);
  stepAt(simulation, CONFIRM_AFTER_WRITE_MS, { limitReadback: { amps: 10, observedAtMs: CONFIRM_AFTER_WRITE_MS } });
  stepAt(simulation, CONFIRM_AFTER_WRITE_MS + SETTLED_FOR_MS - 1, {});
  check("no hall: held during the settle after the readback", holdsAcChargingOn(simulation.state));
  stepAt(simulation, CONFIRM_AFTER_WRITE_MS + SETTLED_FOR_MS, {});
  check(
    "no hall: released on the readback alone after the settle, flagged as such",
    kindsAt(simulation, CONFIRM_AFTER_WRITE_MS + SETTLED_FOR_MS).join() === "released_without_hall" &&
      !holdsAcChargingOn(simulation.state)
  );
}

{
  // Hall ringing around the commit (287 → 6 → 39 → 22 A, 2026-04-03): a sample above the allowance
  // restarts the settle clock
  const simulation = buyingFor(nightBuying);
  stepAt(simulation, 0, windowEnd);
  stepAt(simulation, 6_000, { hallBatteryAmps: 6 });
  stepAt(simulation, CONFIRM_AFTER_WRITE_MS, { limitReadback: { amps: 10, observedAtMs: CONFIRM_AFTER_WRITE_MS } });
  check("released when settled ≥ 3 s at the confirm", !holdsAcChargingOn(simulation.state));
  const ringing = buyingFor(nightBuying);
  stepAt(ringing, 0, windowEnd);
  stepAt(ringing, 6_000, { hallBatteryAmps: 6 });
  stepAt(ringing, 11_000, { hallBatteryAmps: 39 });
  stepAt(ringing, 11_250, { hallBatteryAmps: 22 });
  stepAt(ringing, CONFIRM_AFTER_WRITE_MS, { limitReadback: { amps: 10, observedAtMs: CONFIRM_AFTER_WRITE_MS } });
  check("a 39 A sample 1.5 s before the confirm → still settling", holdsAcChargingOn(ringing.state));
  stepAt(ringing, 14_250, {});
  check(
    "…released 3 s after the ringing ended",
    lastEvent(ringing, "released")?.afterMs === 14_250 && lastEvent(ringing, "released")?.hallSettledForMs === 3_000
  );
}

{
  // A window that only ever charged at the idle cap or below: the readback already proves it
  const simulation = buyingFor({
    ...nightBuying,
    wantedLimitAmps: 8,
    limitReadback: { amps: 8, observedAtMs: -300_000 },
    hallBatteryAmps: 9,
  });
  stepAt(simulation, 0, windowEnd);
  check("8 A window: confirmed at once", kindsAt(simulation, 0).join() === "started,limit_confirmed");
  stepAt(simulation, SETTLED_FOR_MS, {});
  check("…released after the 3 s settle", lastEvent(simulation, "released")?.afterMs === SETTLED_FOR_MS);
}

{
  // Someone else disables AC charging (the inverter's LCD) mid-step-down
  const simulation = buyingFor(nightBuying);
  stepAt(simulation, 0, windowEnd);
  stepAt(simulation, 8_000, { acChargingReadback: "disabled" });
  check(
    "AC charging off by other means → cancelled, nothing held",
    lastEvent(simulation, "cancelled")?.reason === "AC charging already disabled" &&
      !holdsAcChargingOn(simulation.state)
  );
}

if (failedChecks.length) {
  console.error(`\n${failedChecks.length} check(s) FAILED:`, failedChecks.join("; "));
  process.exit(1);
}
console.log("\nAll buy-window end step-down main-path checks passed");

function check(name: string, condition: boolean, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}: ${name} ${detail}`);
  if (!condition) failedChecks.push(name);
}
