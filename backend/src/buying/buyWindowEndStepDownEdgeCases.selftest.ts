/**
 * Pure self-test of the buy-window end step-down, edge cases: a window extended or re-entered while
 * stepping down (with #48's quiet gap and under #62's gap-0 polling), the planner shrinking one, a
 * window ending seconds after it started, a new window starting, stillFeedingIn, a controller restart,
 * and readbacks that predate the latest higher-limit write. Main paths: buyWindowEndStepDown.selftest.ts.
 * Run from backend/ with:  yarn node src/buying/buyWindowEndStepDownEdgeCases.selftest.ts
 */
import process from "process";
import { holdsAcChargingOn, READBACK_COMMIT_MARGIN_MS, SETTLED_FOR_MS } from "./buyWindowEndStepDown.ts";
import {
  bootedWithHallAt,
  buyingFor,
  COMMIT_AFTER_WRITE_MS,
  CONFIRM_AFTER_WRITE_MS,
  hecs,
  heldAtAnyStep,
  holdsAtEveryStep,
  IDENTICAL_SETTER_GATE_MS,
  kindsAt,
  lastEvent,
  nightBuying,
  QUIET_GAP_AFTER_WRITE_MS,
  stepAt,
  windowEnd,
} from "./buyWindowEndStepDownSimulation.ts";

const failedChecks: string[] = [];

{
  // The planner extends the window 5 s into the step-down and shrinks it again at +20 s, on #48's
  // timeline: MUCHGC0100 out at 0.5 s (commits ~6.5 s); MUCHGC2610 out at 5.5 s (commits ~11.5 s) re-arms
  // the quiet gap, so the shared confirm at 17.5 s shows 261 A; the re-end's MUCHGC0100 is the same
  // string sent at 0.5 s, so the identical-setter gate holds it until 60.5 s and it confirms at 72.5 s
  const firstCapSentAtMs = 500;
  const simulation = buyingFor(nightBuying);
  stepAt(simulation, 0, windowEnd);
  stepAt(simulation, 5_000, { gridChargingWanted: true, wantedLimitAmps: 261 });
  check(
    "window extended mid-step-down → cancelled, nothing held (EDB1 and the window's amps again)",
    kindsAt(simulation, 5_000).join() === "cancelled" &&
      lastEvent(simulation, "cancelled")?.reason === "grid charging wanted again" &&
      !holdsAcChargingOn(simulation.state)
  );
  stepAt(simulation, 6_500, { hallBatteryAmps: 11 });
  stepAt(simulation, 11_500, { hallBatteryAmps: 280 });
  stepAt(simulation, 17_500, { limitReadback: { amps: 261, observedAtMs: 17_500 } });
  stepAt(simulation, 20_000, windowEnd);
  const reSentAtMs = firstCapSentAtMs + IDENTICAL_SETTER_GATE_MS;
  const gatedConfirmAtMs = reSentAtMs + QUIET_GAP_AFTER_WRITE_MS;
  const heldUntilGatedConfirm = holdsAtEveryStep(simulation, 20_250, gatedConfirmAtMs - 250, atMs => ({
    hallBatteryAmps: atMs < reSentAtMs + COMMIT_AFTER_WRITE_MS ? 280 : 11,
  }));
  check(
    "re-ended: held while the gated MUCHGC0100 waits — MUCHGC2610 keeps charging at 261 A meanwhile",
    heldUntilGatedConfirm && kindsAt(simulation, 20_000).join() === "started"
  );
  stepAt(simulation, gatedConfirmAtMs, { limitReadback: { amps: 10, observedAtMs: gatedConfirmAtMs } });
  check(
    "…released at the gated cap's confirm, 52.5 s after the re-end",
    lastEvent(simulation, "released")?.afterMs === gatedConfirmAtMs - 20_000,
    `${lastEvent(simulation, "released")?.afterMs} ms`
  );
}

{
  // The same extend-and-re-end under #62's gap-0 strategy, which keeps polling and re-checks BATS every
  // 4 s: end 0 s (MUCHGC0100 commits ~6 s), extension 5 s (MUCHGC2610 commits ~11 s), re-end 8 s (the
  // second MUCHGC0100 gated until 60.5 s). A BATS at 10 s still shows the first cap's 10 A, decoded
  // after the re-end — it must not count while MUCHGC2610 is still committing.
  const simulation = buyingFor(nightBuying);
  stepAt(simulation, 0, windowEnd);
  stepAt(simulation, 5_000, { gridChargingWanted: true, wantedLimitAmps: 261 });
  stepAt(simulation, 6_000, { hallBatteryAmps: 11, limitReadback: { amps: 10, observedAtMs: 6_000 } });
  stepAt(simulation, 8_000, windowEnd);
  stepAt(simulation, 10_000, { limitReadback: { amps: 10, observedAtMs: 10_000 } });
  const heldThroughStaleTen = holdsAtEveryStep(simulation, 10_250, 11_000, () => ({}));
  check(
    `gap 0: a 10 A readback 2 s after the re-end doesn't prove the cap (commit margin ${READBACK_COMMIT_MARGIN_MS / 1000} s)`,
    heldThroughStaleTen && lastEvent(simulation, "limit_confirmed") === undefined
  );
  const gatedCapSentAtMs = 500 + IDENTICAL_SETTER_GATE_MS;
  let heldUntilGatedCommit = true;
  for (let atMs = 11_250; atMs < 70_000; atMs += 250) {
    const reCheck = atMs % 4_000 === 2_000;
    const committedLimit = atMs >= gatedCapSentAtMs + COMMIT_AFTER_WRITE_MS ? 10 : 261;
    stepAt(simulation, atMs, {
      hallBatteryAmps: committedLimit === 10 ? 11 : 280,
      ...(reCheck ? { limitReadback: { amps: committedLimit, observedAtMs: atMs } } : {}),
    });
    if (!holdsAcChargingOn(simulation.state)) heldUntilGatedCommit = false;
  }
  check("gap 0: held while MUCHGC2610 charges at 261 A until the gated cap commits", heldUntilGatedCommit);
  stepAt(simulation, 70_000, { limitReadback: { amps: 10, observedAtMs: 70_000 } });
  check(
    "gap 0: …released at the first 10 A re-check after that commit, and the cap re-asserted once on the way",
    lastEvent(simulation, "released")?.afterMs === 62_000 &&
      simulation.events.filter(recorded => recorded.event.kind === "limit_reasserted").length === 1
  );
}

{
  // A window that ends 5 s after it started: EDB1 + MUCHGC2610 went out at 0 s and committed ~6 s later's
  // ~3 s ramp is already at 150 A, but HECS still shows the pre-window "disabled" (its confirm is due at
  // ~12 s). Without the margin this was a one-step stop at full current.
  const preWindow = {
    ...nightBuying,
    gridChargingWanted: false,
    wantedLimitAmps: 10,
    acChargingReadback: hecs("disabled", -30_000),
    limitReadback: { amps: 10, observedAtMs: -30_000 },
    hallBatteryAmps: -3,
  };
  const simulation = buyingFor(preWindow);
  stepAt(simulation, 0, { gridChargingWanted: true, wantedLimitAmps: 261 });
  stepAt(simulation, 4_000, { hallBatteryAmps: 150 });
  stepAt(simulation, 5_000, windowEnd);
  check(
    "window ends 5 s in with HECS still pre-window 'disabled' → step-down starts, EDB0 held",
    kindsAt(simulation, 5_000).join() === "started" && holdsAcChargingOn(simulation.state)
  );
  // #62's gap 0 could poll HECS before EDB1 commits: that "disabled" is too close to the wish to cancel
  stepAt(simulation, 9_000, { acChargingReadback: hecs("disabled", 9_000), hallBatteryAmps: 270 });
  check("…a 'disabled' 4 s after the end can't cancel it", holdsAcChargingOn(simulation.state));
  // MUCHGC0100 out at 5.4 s (not gated) re-arms the quiet gap; the shared confirm at 17.4 s shows both
  stepAt(simulation, 11_400, { hallBatteryAmps: 11 });
  const heldUntilConfirm = holdsAtEveryStep(simulation, 11_500, 17_250, () => ({}));
  stepAt(simulation, 17_400, {
    acChargingReadback: hecs("enabled", 17_400),
    limitReadback: { amps: 10, observedAtMs: 17_400 },
  });
  check(
    "…released only at the confirm proving the cap, 12.4 s after the end",
    heldUntilConfirm && lastEvent(simulation, "released")?.afterMs === 12_400
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
    "window shrunk mid-slot: the in-window write's 255 A confirm holds it (and re-asserts the cap), the 10 A retry releases it",
    heldUntilRetry &&
      lastEvent(simulation, "released")?.afterMs === 42_500 &&
      lastEvent(simulation, "limit_reasserted")?.limitReadbackAmps === 255
  );
}

{
  // Readbacks just around the end of a higher wish still show the old 10 A — they must not count
  const simulation = buyingFor({
    ...nightBuying,
    gridChargingWanted: false,
    wantedLimitAmps: 10,
    acChargingReadback: hecs("disabled", -600_000),
    limitReadback: { amps: 10, observedAtMs: -600_000 },
    hallBatteryAmps: -5,
  });
  stepAt(simulation, 100_000, {
    gridChargingWanted: true,
    wantedLimitAmps: 261,
    acChargingReadback: hecs("enabled", 99_000),
  });
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
  // A step-down started on a stale pre-window "disabled" (the window ended 5 s in): once released, only a
  // HECS readback newer than the release may end it — the stale one would end it at once and restart it
  const simulation = buyingFor({
    ...nightBuying,
    gridChargingWanted: false,
    wantedLimitAmps: 10,
    acChargingReadback: hecs("disabled", -30_000),
    hallBatteryAmps: -3,
  });
  stepAt(simulation, 0, { gridChargingWanted: true, wantedLimitAmps: 261 });
  stepAt(simulation, 5_000, { ...windowEnd, hallBatteryAmps: 11 });
  stepAt(simulation, 17_400, { limitReadback: { amps: 10, observedAtMs: 17_400 } });
  const restartedOnStaleHecs = heldAtAnyStep(simulation, 17_500, 29_000, () => ({}));
  check(
    "released on a stale 'disabled' → stays released, never restarts a step-down",
    simulation.state.progress.phase === "released" &&
      !restartedOnStaleHecs &&
      simulation.events.filter(recorded => recorded.event.kind === "started").length === 1
  );
  stepAt(simulation, 29_500, { acChargingReadback: hecs("disabled", 29_500) });
  stepAt(simulation, 40_000, {});
  check(
    "…EDB0's own HECS confirm ends it, and idle stays idle",
    lastEvent(simulation, "ac_charging_disabled_confirmed") !== undefined && simulation.state.progress.phase === "idle"
  );
}

{
  // A window that ends (or that the planner deletes) while feeding is still being switched off: EDB1 was
  // never sent, so there is nothing to step down
  const simulation = buyingFor({
    ...nightBuying,
    wantedLimitAmps: 10,
    acChargingReadback: hecs("disabled", -30_000),
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
  stepAt(simulation, 14_000, { acChargingReadback: hecs("enabled", 14_000) });
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
  stepAt(notYetCommitted, 14_000, { acChargingReadback: hecs("enabled", 14_000) });
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
