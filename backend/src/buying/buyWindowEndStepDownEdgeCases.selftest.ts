/**
 * Pure self-test of the buy-window end step-down, edge cases: a window extended or re-entered while
 * stepping down, the planner shrinking one, a new window starting, stillFeedingIn, a controller restart,
 * and readbacks that predate the latest higher-limit write. Main paths: buyWindowEndStepDown.selftest.ts.
 * Run from backend/ with:  yarn node src/buying/buyWindowEndStepDownEdgeCases.selftest.ts
 */
import process from "process";
import { holdsAcChargingOn, SETTLED_FOR_MS } from "./buyWindowEndStepDown.ts";
import {
  bootedWithHallAt,
  buyingFor,
  COMMIT_AFTER_WRITE_MS,
  CONFIRM_AFTER_WRITE_MS,
  holdsAtEveryStep,
  kindsAt,
  lastEvent,
  nightBuying,
  stepAt,
  windowEnd,
} from "./buyWindowEndStepDownSimulation.ts";

const failedChecks: string[] = [];

{
  // The planner extends the window 5 s into the step-down, then shrinks it again at +20 s
  const simulation = buyingFor(nightBuying);
  stepAt(simulation, 0, windowEnd);
  stepAt(simulation, 5_000, { gridChargingWanted: true, wantedLimitAmps: 261 });
  check(
    "window extended mid-step-down → cancelled, nothing held (EDB1 and the window's amps again)",
    kindsAt(simulation, 5_000).join() === "cancelled" &&
      lastEvent(simulation, "cancelled")?.reason === "grid charging wanted again" &&
      !holdsAcChargingOn(simulation.state)
  );
  // MUCHGC0100's confirm still lands during the extension (it shows 10 A), MUCHGC2610 commits after it
  stepAt(simulation, CONFIRM_AFTER_WRITE_MS, { limitReadback: { amps: 10, observedAtMs: CONFIRM_AFTER_WRITE_MS } });
  stepAt(simulation, 18_000, { hallBatteryAmps: 280 });
  stepAt(simulation, 20_000, windowEnd);
  const heldOnStaleReadback = holdsAtEveryStep(simulation, 20_250, 32_000, atMs => ({
    hallBatteryAmps: atMs < 20_000 + COMMIT_AFTER_WRITE_MS ? 280 : 11,
  }));
  check(
    "re-ended: the 10 A readback from during the extension can't vouch for the cap → held",
    heldOnStaleReadback && kindsAt(simulation, 20_000).join() === "started"
  );
  stepAt(simulation, 32_500, { limitReadback: { amps: 10, observedAtMs: 32_500 } });
  check(
    "…a readback after the re-end confirms it → released 12.5 s after the re-end",
    lastEvent(simulation, "released")?.afterMs === 12_500
  );
}

{
  // The planner shrinks the running window to end now, 3 s after an in-window MUCHGC2550: the shared
  // confirm at +12.5 s still shows 255 A (MUCHGC0100 not committed yet), the retry at +42.5 s shows 10 A
  const simulation = buyingFor(nightBuying);
  stepAt(simulation, -3_000, { wantedLimitAmps: 255 });
  stepAt(simulation, 0, windowEnd);
  stepAt(simulation, CONFIRM_AFTER_WRITE_MS, { limitReadback: { amps: 255, observedAtMs: CONFIRM_AFTER_WRITE_MS } });
  const heldUntilRetry = holdsAtEveryStep(simulation, 12_750, 42_250, atMs => ({
    hallBatteryAmps: atMs < 30_000 ? 270 : 11,
  }));
  stepAt(simulation, 42_500, { limitReadback: { amps: 10, observedAtMs: 42_500 } });
  check(
    "window shrunk mid-slot: the in-window write's 255 A confirm holds it, the 10 A retry releases it",
    heldUntilRetry && lastEvent(simulation, "released")?.afterMs === 42_500
  );
}

{
  // A readback decoded just after a higher limit was wanted (the BATS query already on the wire) still
  // shows the old 10 A — it must not count once that wish ends again
  const simulation = buyingFor({
    ...nightBuying,
    gridChargingWanted: false,
    wantedLimitAmps: 10,
    acChargingReadback: "disabled",
    limitReadback: { amps: 10, observedAtMs: -600_000 },
    hallBatteryAmps: -5,
  });
  stepAt(simulation, 100_000, { gridChargingWanted: true, wantedLimitAmps: 261, acChargingReadback: "enabled" });
  stepAt(simulation, 100_300, { limitReadback: { amps: 10, observedAtMs: 100_300 } });
  stepAt(simulation, 105_000, windowEnd);
  stepAt(simulation, 110_000, { hallBatteryAmps: 11 });
  check(
    "a 10 A readback decoded 0.3 s into a higher wish doesn't prove the cap after that wish ends",
    holdsAcChargingOn(simulation.state) && lastEvent(simulation, "limit_confirmed") === undefined
  );

  // Same idea within one step: a BATS decoded in the window-end tick itself predates MUCHGC0100
  const sameTick = buyingFor({ ...nightBuying, limitReadback: { amps: 10, observedAtMs: -600_000 } });
  stepAt(sameTick, 0, { ...windowEnd, limitReadback: { amps: 10, observedAtMs: -200 }, hallBatteryAmps: 11 });
  stepAt(sameTick, 5_000, {});
  check(
    "a readback observed between the last step and the window-end step doesn't prove the cap",
    holdsAcChargingOn(sameTick.state) && lastEvent(sameTick, "limit_confirmed") === undefined
  );
}

{
  // A new buy window starts after EDB0 was released, before its HECS confirm
  const simulation = buyingFor(nightBuying);
  stepAt(simulation, 0, windowEnd);
  stepAt(simulation, 6_000, { hallBatteryAmps: 11 });
  stepAt(simulation, CONFIRM_AFTER_WRITE_MS, { limitReadback: { amps: 10, observedAtMs: CONFIRM_AFTER_WRITE_MS } });
  stepAt(simulation, 15_000, { gridChargingWanted: true, wantedLimitAmps: 250 });
  check(
    "new window right after the release → superseded, back to idle (EDB1 desired again)",
    kindsAt(simulation, 15_000).join() === "release_superseded" && simulation.state.progress.phase === "idle"
  );
  // EDB0 had gone out but its commit never showed; the new window ends with HECS still "enabled"
  stepAt(simulation, 40_000, windowEnd);
  check(
    "…and its own end steps down again",
    kindsAt(simulation, 40_000).join() === "started" && holdsAcChargingOn(simulation.state)
  );
}

{
  // A window that ends (or that the planner deletes) while feeding is still being switched off: EDB1 was
  // never sent, so there is nothing to step down
  const simulation = buyingFor({
    ...nightBuying,
    wantedLimitAmps: 10,
    acChargingReadback: "disabled",
    hallBatteryAmps: -40,
  });
  check("feeding still on: grid charging wanted but no step-down", !holdsAcChargingOn(simulation.state));
  stepAt(simulation, 1_000, windowEnd);
  check(
    "window gone before AC charging was ever enabled → no step-down, EDB0 free",
    !holdsAcChargingOn(simulation.state) && simulation.events.length === 0
  );
  // stillFeedingIn flipping back on mid-window (shouldBuy false, the cap wanted) never starts one either
  const feedingBackOn = buyingFor({ ...nightBuying, wantedLimitAmps: 10 });
  stepAt(feedingBackOn, 1_000, {});
  check("stillFeedingIn mid-window with AC charging on → no step-down", !holdsAcChargingOn(feedingBackOn.state));
}

{
  // Controller restart after a window ended at full current (or mid-step-down): nothing persisted.
  // At boot MUCHGC0100 goes out first, its confirm comes before the first settings poll's HECS.
  const simulation = bootedWithHallAt(280);
  stepAt(simulation, 0, {});
  check(
    "boot before any readback: nothing held, EDB effect waits for HECS anyway",
    !holdsAcChargingOn(simulation.state)
  );
  stepAt(simulation, 6_500, { hallBatteryAmps: 11 });
  stepAt(simulation, 12_600, { limitReadback: { amps: 10, observedAtMs: 12_600 } });
  stepAt(simulation, 14_000, { acChargingReadback: "enabled" });
  check(
    "boot: HECS shows AC charging on with no window → step-down starts, the boot confirm proves the cap",
    kindsAt(simulation, 14_000).join() === "started,limit_confirmed" && holdsAcChargingOn(simulation.state)
  );
  stepAt(simulation, 14_000 + SETTLED_FOR_MS, {});
  check(
    "…released once the hall has been watched settled for 3 s",
    lastEvent(simulation, "released")?.afterMs === SETTLED_FOR_MS && !holdsAcChargingOn(simulation.state)
  );

  // The boot write committed late: its first confirm still shows the old 261 A, the retry 30 s on shows 10 A
  const notYetCommitted = bootedWithHallAt(280);
  stepAt(notYetCommitted, 12_600, { limitReadback: { amps: 261, observedAtMs: 12_600 } });
  stepAt(notYetCommitted, 14_000, { acChargingReadback: "enabled" });
  stepAt(notYetCommitted, 30_000, {});
  check("boot with the old 261 A still in BATS → held", holdsAcChargingOn(notYetCommitted.state));
  stepAt(notYetCommitted, 40_000, { hallBatteryAmps: 12 });
  stepAt(notYetCommitted, 42_600, { limitReadback: { amps: 10, observedAtMs: 42_600 } });
  check(
    "…the confirm retry shows 10 A, but the hall has only been low for 2.6 s → still held",
    holdsAcChargingOn(notYetCommitted.state)
  );
  stepAt(notYetCommitted, 43_000, {});
  check("…released once the hall has held for 3 s", !holdsAcChargingOn(notYetCommitted.state));
}

if (failedChecks.length) {
  console.error(`\n${failedChecks.length} check(s) FAILED:`, failedChecks.join("; "));
  process.exit(1);
}
console.log("\nAll buy-window end step-down edge-case checks passed");

function check(name: string, condition: boolean, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}: ${name} ${detail}`);
  if (!condition) failedChecks.push(name);
}
