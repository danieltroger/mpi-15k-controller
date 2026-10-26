/**
 * Pure self-test of the buy-window end step-down, edge cases: a window extended or re-entered while
 * stepping down (with #48's quiet gap and under #62's gap 0, including the scheduler's ABA), the
 * planner shrinking one, a window ending seconds after it started, a new window starting,
 * stillFeedingIn, a controller restart, and readbacks that predate the latest higher-limit write.
 * Main paths: buyWindowEndStepDown.selftest.ts.
 * Run from backend/ with:  yarn node src/buying/buyWindowEndStepDownEdgeCases.selftest.ts
 */
import process from "process";
import { holdsAcChargingOn, SETTLED_FOR_MS, STEP_DOWN_TIMEOUT_MS } from "./buyWindowEndStepDown.ts";
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
/** A window that hasn't started yet: AC charging off at the 10 A cap, nothing ever switched on */
const preWindow = {
  ...nightBuying,
  gridChargingWanted: false,
  acChargingReadback: hecs("disabled", -30_000),
  limitReadback: { amps: 10, observedAtMs: -30_000 },
  lastAboveIdleLimitSentAtMs: undefined,
  lastAcChargingEnableSentAtMs: undefined,
  hallBatteryAmps: -3,
};

{
  // The planner extends the window 5 s into the step-down and shrinks it again at +20 s, on #48's
  // timeline: MUCHGC0100 out at 0.5 s (commits ~6.5 s); MUCHGC2610 acknowledged at 5.8 s (commits
  // ~11.8 s) re-arms the quiet gap, so the shared confirm at 17.8 s shows 261 A; the re-end's MUCHGC0100
  // is the same string sent at 0.5 s, so the identical-setter gate holds it until 60.5 s
  const firstCapSentAtMs = 500;
  const simulation = buyingFor(nightBuying);
  stepAt(simulation, 0, windowEnd);
  stepAt(simulation, 5_000, { gridChargingWanted: true });
  check(
    "window extended mid-step-down → cancelled, nothing held (EDB1 and the window's amps again)",
    kindsAt(simulation, 5_000).join() === "cancelled" &&
      lastEvent(simulation, "cancelled")?.reason === "grid charging wanted again" &&
      !holdsAcChargingOn(simulation.state)
  );
  stepAt(simulation, 5_800, { lastAboveIdleLimitSentAtMs: 5_800 });
  stepAt(simulation, 6_500, { hallBatteryAmps: 11 });
  stepAt(simulation, 11_800, { hallBatteryAmps: 280 });
  stepAt(simulation, 17_800, { limitReadback: { amps: 261, observedAtMs: 17_800 } });
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
  // The same extend-and-re-end under #62's gap 0, which keeps polling and re-checks BATS every 4 s: end
  // 0 s (MUCHGC0100 commits ~6 s), extension 5 s (MUCHGC2610 acknowledged at 5.3 s, commits ~11 s), re-end
  // 8 s (the second MUCHGC0100 gated until 60.5 s). A BATS at 10 s still shows the first cap's 10 A — read
  // after MUCHGC2610 went out, so it counts as evidence, but the hall must still carry it past that
  // write's commit horizon, and MUCHGC2610's commit takes the hall up to 280 A first.
  const simulation = buyingFor(nightBuying);
  stepAt(simulation, 0, windowEnd);
  stepAt(simulation, 5_000, { gridChargingWanted: true });
  stepAt(simulation, 5_300, { lastAboveIdleLimitSentAtMs: 5_300 });
  stepAt(simulation, 6_000, { hallBatteryAmps: 11, limitReadback: { amps: 10, observedAtMs: 6_000 } });
  stepAt(simulation, 8_000, windowEnd);
  stepAt(simulation, 10_000, { limitReadback: { amps: 10, observedAtMs: 10_000 } });
  const gatedCapSentAtMs = 500 + IDENTICAL_SETTER_GATE_MS;
  let heldUntilGatedCommit = true;
  for (let atMs = 10_250; atMs < 70_000; atMs += 250) {
    const reCheck = atMs % 4_000 === 2_000;
    const committedLimit = atMs >= gatedCapSentAtMs + COMMIT_AFTER_WRITE_MS ? 10 : atMs >= 11_000 ? 261 : 10;
    stepAt(simulation, atMs, {
      hallBatteryAmps: committedLimit === 10 ? 11 : 280,
      ...(reCheck ? { limitReadback: { amps: committedLimit, observedAtMs: atMs } } : {}),
    });
    if (!holdsAcChargingOn(simulation.state)) heldUntilGatedCommit = false;
  }
  check("gap 0: held while MUCHGC2610 charges at 261 A until the gated cap commits", heldUntilGatedCommit);
  stepAt(simulation, 70_000, { limitReadback: { amps: 10, observedAtMs: 70_000 } });
  check(
    "gap 0: …released at the first 10 A re-check after that commit, the cap re-asserted once on the way",
    lastEvent(simulation, "released")?.afterMs === 62_000 &&
      simulation.events.filter(recorded => recorded.event.kind === "limit_reasserted").length === 1
  );
}

{
  // The review's gap-0 ABA: commits take ~12 s. MUCHGC0100 out at 0.75 s, MUCHGC2610 acknowledged at
  // 5.3 s (extension), re-end at 8 s. The interleaved confirm at 12.25 s reads the pre-step-down 261 A
  // (which "confirms" MUCHGC2610), MUCHGC0100 commits at 12.75 s, the settings poll at 14 s reads 10 A —
  // then MUCHGC2610 commits at 17 s and nothing re-sends the cap: the session dropped the re-asserted
  // one as satisfied. The hall shows it: no release; at the timeout the hold is extended instead of EDB0.
  const simulation = buyingFor(nightBuying);
  stepAt(simulation, 0, windowEnd);
  stepAt(simulation, 5_000, { gridChargingWanted: true });
  stepAt(simulation, 5_300, { lastAboveIdleLimitSentAtMs: 5_300 });
  stepAt(simulation, 8_000, windowEnd);
  stepAt(simulation, 12_250, { limitReadback: { amps: 261, observedAtMs: 12_250 } });
  stepAt(simulation, 12_750, { hallBatteryAmps: 11 });
  stepAt(simulation, 14_000, { limitReadback: { amps: 10, observedAtMs: 14_000 } });
  const heldAtFullCurrent = holdsAtEveryStep(simulation, 14_250, 8_000 + STEP_DOWN_TIMEOUT_MS - 250, atMs => ({
    hallBatteryAmps: atMs < 17_000 ? 11 : 280,
  }));
  stepAt(simulation, 8_000 + STEP_DOWN_TIMEOUT_MS, {});
  check(
    "gap-0 ABA: BATS shows 10 A but MUCHGC2610's late commit puts 280 A on the hall → held, and extended at the timeout",
    heldAtFullCurrent &&
      lastEvent(simulation, "released") === undefined &&
      lastEvent(simulation, "hold_extended")?.afterMs === STEP_DOWN_TIMEOUT_MS &&
      holdsAcChargingOn(simulation.state)
  );
  // The next settings poll reads the real 261 A: the extension's re-assertion gets the cap sent again
  stepAt(simulation, 194_000, { limitReadback: { amps: 261, observedAtMs: 194_000 } });
  const reassertedInExtension = lastEvent(simulation, "limit_reasserted")?.afterMs === 194_000 - 8_000;
  holdsAtEveryStep(simulation, 194_250, 206_500, atMs => ({ hallBatteryAmps: atMs < 206_000 ? 280 : 11 }));
  stepAt(simulation, 206_500, { limitReadback: { amps: 10, observedAtMs: 206_500 } });
  stepAt(simulation, 209_000, {});
  check(
    "…the extension's re-assertion lands, and the step-down releases on its own proof — not at full current",
    reassertedInExtension &&
      lastEvent(simulation, "released")?.afterMs === 209_000 - 8_000 &&
      lastEvent(simulation, "timed_out") === undefined
  );
}

{
  // A window that ends 5 s after it started: EDB1 (acknowledged at 0.3 s) + MUCHGC2610 (0.6 s) commit at
  // ~6 s, but the end comes first and HECS still shows the pre-window "disabled" (its confirm is due at
  // ~12 s). Without the margin this was a one-step stop at full current.
  const simulation = buyingFor(preWindow);
  stepAt(simulation, 0, { gridChargingWanted: true });
  stepAt(simulation, 300, { lastAcChargingEnableSentAtMs: 300 });
  stepAt(simulation, 600, { lastAboveIdleLimitSentAtMs: 600 });
  stepAt(simulation, 4_000, { hallBatteryAmps: 150 });
  stepAt(simulation, 5_000, windowEnd);
  check(
    "window ends 5 s in with HECS still pre-window 'disabled' → step-down starts, EDB0 held",
    kindsAt(simulation, 5_000).join() === "started" && holdsAcChargingOn(simulation.state)
  );
  // #62's gap 0 could poll HECS before EDB1 commits: that "disabled" is too close to EDB1 to cancel
  stepAt(simulation, 9_000, { acChargingReadback: hecs("disabled", 9_000), hallBatteryAmps: 270 });
  check("…a 'disabled' 8.7 s after EDB1 went out can't cancel it", holdsAcChargingOn(simulation.state));
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

  // The same under gap 0: the cap's interleaved confirm reads 10 A at 11.5 s — evidence at once, and the
  // release comes 3 s past MUCHGC2610's commit horizon (12.6 s), not at the timeout
  const gapZero = buyingFor(preWindow);
  stepAt(gapZero, 0, { gridChargingWanted: true });
  stepAt(gapZero, 300, { lastAcChargingEnableSentAtMs: 300 });
  stepAt(gapZero, 600, { lastAboveIdleLimitSentAtMs: 600 });
  stepAt(gapZero, 4_000, { hallBatteryAmps: 150 });
  stepAt(gapZero, 5_000, windowEnd);
  stepAt(gapZero, 11_400, { hallBatteryAmps: 11 });
  stepAt(gapZero, 11_500, { limitReadback: { amps: 10, observedAtMs: 11_500 } });
  const heldPastHorizon = holdsAtEveryStep(gapZero, 11_750, 15_500, () => ({}));
  stepAt(gapZero, 15_600, {});
  check(
    "gap 0, window ending 5 s in: released 3 s past the last higher-limit write's horizon (10.6 s after the end)",
    heldPastHorizon && lastEvent(gapZero, "released")?.afterMs === 10_600
  );
}

{
  // The planner shrinks the running window to end now, 3 s after an in-window MUCHGC2550: the shared
  // confirm at +12.5 s still shows 255 A (MUCHGC0100 not committed yet), the retry at +42.5 s shows 10 A
  const simulation = buyingFor({ ...nightBuying, lastAboveIdleLimitSentAtMs: -2_700 });
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
  // A readback decoded just before a higher-limit write went out (the BATS query already on the wire when
  // a window charging at the cap raised its amps) still shows the old 10 A — it can't vouch for the cap
  const simulation = buyingFor({
    ...preWindow,
    gridChargingWanted: true,
    acChargingReadback: hecs("enabled", -600_000),
  });
  stepAt(simulation, 100_300, { limitReadback: { amps: 10, observedAtMs: 100_300 } });
  stepAt(simulation, 100_600, { lastAboveIdleLimitSentAtMs: 100_600 });
  stepAt(simulation, 105_000, { ...windowEnd, hallBatteryAmps: 11 });
  stepAt(simulation, 110_000, {});
  check(
    "a 10 A readback from before the last higher-limit write doesn't count, even with the hall low",
    holdsAcChargingOn(simulation.state) && lastEvent(simulation, "limit_confirmed") === undefined
  );
}

{
  // A new buy window starts after EDB0 was released, before its HECS confirm
  const simulation = buyingFor(nightBuying);
  stepAt(simulation, 0, windowEnd);
  stepAt(simulation, 6_000, { hallBatteryAmps: 11 });
  stepAt(simulation, CONFIRM_AFTER_WRITE_MS, { limitReadback: { amps: 10, observedAtMs: CONFIRM_AFTER_WRITE_MS } });
  stepAt(simulation, 15_000, { gridChargingWanted: true });
  check(
    "new window right after the release → superseded, back to idle (EDB1 desired again)",
    kindsAt(simulation, 15_000).join() === "release_superseded" && simulation.state.progress.phase === "idle"
  );
  // The new window's MUCHGC2500 goes out; EDB0 had gone out but its commit never showed, so the window
  // ends with HECS still "enabled"
  stepAt(simulation, 15_300, { lastAboveIdleLimitSentAtMs: 15_300 });
  stepAt(simulation, 40_000, windowEnd);
  check(
    "…and its own end steps down again",
    kindsAt(simulation, 40_000).join() === "started" && holdsAcChargingOn(simulation.state)
  );
}

{
  // A step-down started on a stale pre-window "disabled" (the window ended 5 s in): once released, only a
  // HECS readback newer than the release may end it — the stale one would end it at once and restart it
  const simulation = buyingFor(preWindow);
  stepAt(simulation, 0, { gridChargingWanted: true });
  stepAt(simulation, 300, { lastAcChargingEnableSentAtMs: 300 });
  stepAt(simulation, 600, { lastAboveIdleLimitSentAtMs: 600 });
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
  const simulation = buyingFor({ ...preWindow, gridChargingWanted: true, hallBatteryAmps: -40 });
  check("feeding still on: grid charging wanted but no step-down", !holdsAcChargingOn(simulation.state));
  stepAt(simulation, 1_000, windowEnd);
  check(
    "window gone before AC charging was ever enabled → no step-down, EDB0 free",
    !holdsAcChargingOn(simulation.state) && simulation.events.length === 0
  );
  // stillFeedingIn flipping back on mid-window (charging still wanted) never starts one either
  const feedingBackOn = buyingFor(nightBuying);
  stepAt(feedingBackOn, 1_000, {});
  check("stillFeedingIn mid-window with AC charging on → no step-down", !holdsAcChargingOn(feedingBackOn.state));
}

{
  // Controller restart after a window ended at full current (or mid-step-down): nothing persisted, a
  // fresh session's send record is empty. At boot MUCHGC0100 goes out first, its confirm comes before
  // the first settings poll's HECS.
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
