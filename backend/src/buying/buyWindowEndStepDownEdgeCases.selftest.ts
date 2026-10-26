/**
 * Pure self-test of the buy-window end step-down, edge cases: a window extended or re-entered while
 * stepping down (with #48's quiet gap and under #62's gap 0), the planner shrinking one, a window ending
 * seconds after it started, a new window starting, stillFeedingIn, a controller restart, and readbacks
 * that predate the latest higher-limit write. Main paths: buyWindowEndStepDown.selftest.ts; the chain's
 * A→B→A and trust-window cases: buyWindowEndStepDownChains.selftest.ts.
 * Run from backend/ with:  yarn node src/buying/buyWindowEndStepDownEdgeCases.selftest.ts
 */
import process from "process";
import { alternateCapRequests, holdsAcChargingOn } from "./buyWindowEndStepDown.ts";
import { SETTLED_FOR_MS } from "./buyWindowEndEvidence.ts";
import {
  batsAt,
  bootedWithHallAt,
  buyingFor,
  CAP_SENT_AFTER_END_MS,
  COMMIT_AFTER_WRITE_MS,
  CONFIRM_AFTER_WRITE_MS,
  endWindow,
  hecs,
  hecsAt,
  heldAtAnyStep,
  holdsAtEveryStep,
  IDENTICAL_SETTER_GATE_MS,
  kindsAt,
  lastEvent,
  nightBuying,
  QUIET_GAP_AFTER_WRITE_MS,
  sentAt,
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
  hallBatteryAmps: -3,
};

{
  // The planner extends the window 5 s into the step-down and shrinks it again at +20 s, on #48's
  // timeline: MUCHGC0100 out at 0.5 s (commits ~6.5 s); MUCHGC2610 acknowledged at 5.8 s (commits
  // ~11.8 s) re-arms the quiet gap, so the shared confirm at 17.8 s shows 261 A — which the chain can't
  // tell from "nothing landed yet". The re-end's MUCHGC0100 is the same string sent at 0.5 s, so the
  // identical-setter gate holds it until 60.5 s.
  const simulation = buyingFor(nightBuying);
  endWindow(simulation);
  stepAt(simulation, 5_000, { gridChargingWanted: true });
  check(
    "window extended mid-step-down → cancelled, nothing held (EDB1 and the window's amps again)",
    kindsAt(simulation, 5_000).join() === "cancelled" &&
      lastEvent(simulation, "cancelled")?.reason === "grid charging wanted again" &&
      !holdsAcChargingOn(simulation.state)
  );
  stepAt(simulation, 5_800, sentAt(simulation, "MUCHGC2610", 5_800));
  stepAt(simulation, 6_500, { hallBatteryAmps: 11 });
  stepAt(simulation, 11_800, { hallBatteryAmps: 280 });
  stepAt(simulation, 17_800, batsAt(simulation, 261, 17_800));
  stepAt(simulation, 20_000, windowEnd);
  const reSentAtMs = CAP_SENT_AFTER_END_MS + IDENTICAL_SETTER_GATE_MS;
  const gatedConfirmAtMs = reSentAtMs + QUIET_GAP_AFTER_WRITE_MS;
  stepAt(simulation, reSentAtMs, sentAt(simulation, "MUCHGC0100", reSentAtMs));
  const heldUntilGatedConfirm = holdsAtEveryStep(simulation, reSentAtMs + 250, gatedConfirmAtMs - 250, atMs => ({
    hallBatteryAmps: atMs < reSentAtMs + COMMIT_AFTER_WRITE_MS ? 280 : 11,
  }));
  check(
    "re-ended: held while the gated MUCHGC0100 waits — MUCHGC2610 keeps charging at 261 A meanwhile",
    heldUntilGatedConfirm && kindsAt(simulation, 20_000).join() === "started"
  );
  // Every write landed, but "10 A" after 10 → 261 → 10 can also mean only the first cap did, with 261 A
  // still to come: the alternate cap settles it, its 9 A readback a quiet gap later
  stepAt(simulation, gatedConfirmAtMs, batsAt(simulation, 10, gatedConfirmAtMs));
  const ambiguity = lastEvent(simulation, "ambiguous_limit_readback");
  check(
    "…the gated cap's 10 A confirm can't prove MUCHGC2610 landed → held, the alternate cap asked for",
    holdsAcChargingOn(simulation.state) &&
      ambiguity?.unprovenHigherLimitsAmps.join() === "261" &&
      alternateCapRequests(simulation.state) === 1,
    JSON.stringify(ambiguity)
  );
  const alternateSentAtMs = gatedConfirmAtMs + 300;
  stepAt(simulation, alternateSentAtMs, sentAt(simulation, "MUCHGC0090", alternateSentAtMs));
  stepAt(simulation, 75_000, batsAt(simulation, 10, 75_000));
  check(
    "…a 10 A readback before the alternate cap lands is as ambiguous, but doesn't ask for it a second time",
    alternateCapRequests(simulation.state) === 1 &&
      simulation.events.filter(recorded => recorded.event.kind === "ambiguous_limit_readback").length === 1
  );
  stepAt(simulation, alternateSentAtMs + COMMIT_AFTER_WRITE_MS, { hallBatteryAmps: 9 });
  const alternateConfirmAtMs = alternateSentAtMs + QUIET_GAP_AFTER_WRITE_MS;
  stepAt(simulation, alternateConfirmAtMs, batsAt(simulation, 9, alternateConfirmAtMs));
  check(
    "…released on the alternate cap's 9 A confirm, 64.8 s after the re-end — no timeout",
    lastEvent(simulation, "released")?.afterMs === alternateConfirmAtMs - 20_000 &&
      lastEvent(simulation, "timed_out") === undefined,
    `${lastEvent(simulation, "released")?.afterMs} ms`
  );
}

{
  // The same extend-and-re-end under #62's gap 0: end 0 s (MUCHGC0100 commits ~6.5 s), extension 5 s
  // (MUCHGC2610 acknowledged at 5.3 s, commits ~11.3 s), re-end 8 s. The cap's interleaved confirm at
  // 6.5 s reads 10 A — after MUCHGC2610 went out, but MUCHGC2610 is still unproven (and still to land).
  const simulation = buyingFor(nightBuying);
  endWindow(simulation);
  stepAt(simulation, 5_000, { gridChargingWanted: true });
  stepAt(simulation, 5_300, sentAt(simulation, "MUCHGC2610", 5_300));
  stepAt(simulation, 6_500, { hallBatteryAmps: 11, ...batsAt(simulation, 10, 6_500) });
  stepAt(simulation, 8_000, windowEnd);
  stepAt(simulation, 10_500, batsAt(simulation, 10, 10_500));
  const heldWhileUnproven = holdsAtEveryStep(simulation, 10_750, 11_250, () => ({}));
  check(
    "gap 0: a 10 A readback with MUCHGC2610 unproven proves nothing → held, the hall low notwithstanding",
    heldWhileUnproven && lastEvent(simulation, "limit_confirmed") === undefined
  );
  // MUCHGC2610 lands at 11.3 s and its re-check at 14.5 s sees it: the cap is re-asserted, and the re-end's
  // MUCHGC0100 goes out when its gate opens (60.5 s), committing at 66.5 s
  stepAt(simulation, 11_300, { hallBatteryAmps: 280 });
  stepAt(simulation, 14_500, batsAt(simulation, 261, 14_500));
  const gatedCapSentAtMs = CAP_SENT_AFTER_END_MS + IDENTICAL_SETTER_GATE_MS;
  stepAt(simulation, gatedCapSentAtMs, sentAt(simulation, "MUCHGC0100", gatedCapSentAtMs));
  const heldAtFullCurrent = holdsAtEveryStep(simulation, 60_750, 66_250, () => ({}));
  stepAt(simulation, 66_500, { hallBatteryAmps: 11, ...batsAt(simulation, 10, 66_500) });
  stepAt(simulation, 69_500, {});
  check(
    "gap 0: …held while MUCHGC2610 charges at 261 A, released 3 s after the gated cap's first 10 A re-check",
    heldAtFullCurrent &&
      lastEvent(simulation, "released")?.afterMs === 61_500 &&
      simulation.events.filter(recorded => recorded.event.kind === "limit_reasserted").length === 1 &&
      lastEvent(simulation, "ambiguous_limit_readback") === undefined
  );
}

{
  // The review's gap-0 ABA with ~12 s commits: MUCHGC0100 out at 0.75 s, MUCHGC2610 at 5.3 s (extension),
  // re-end at 8 s. The interleaved confirm at 12.25 s reads the pre-step-down 261 A, MUCHGC0100 commits at
  // 12.75 s, the settings poll at 14 s reads 10 A — then MUCHGC2610 commits at 17.3 s. Under the 12 s
  // margin the 14 s readback proved the cap; in the chain MUCHGC2610 is still unproven, so it doesn't.
  const simulation = buyingFor(nightBuying);
  stepAt(simulation, 0, windowEnd);
  stepAt(simulation, 750, sentAt(simulation, "MUCHGC0100", 750));
  stepAt(simulation, 5_000, { gridChargingWanted: true });
  stepAt(simulation, 5_300, sentAt(simulation, "MUCHGC2610", 5_300));
  stepAt(simulation, 8_000, windowEnd);
  stepAt(simulation, 12_250, batsAt(simulation, 261, 12_250));
  stepAt(simulation, 12_750, { hallBatteryAmps: 11 });
  stepAt(simulation, 14_000, batsAt(simulation, 10, 14_000));
  const heldThroughLateCommit = holdsAtEveryStep(simulation, 14_250, 22_000, atMs => ({
    hallBatteryAmps: atMs < 17_300 ? 11 : 280,
    ...(atMs === 18_250 ? batsAt(simulation, 261, atMs) : {}),
  }));
  check(
    "gap-0 ABA: BATS shows 10 A while MUCHGC2610 is unproven → never confirmed; its late commit is seen at 18.25 s",
    heldThroughLateCommit &&
      lastEvent(simulation, "limit_confirmed") === undefined &&
      lastEvent(simulation, "released") === undefined
  );
  // #62 no longer drops the re-asserted MUCHGC0100 as satisfied (MUCHGC2610 was unproven): it goes out when
  // its gate opens, commits ~12 s later, and its re-check proves the cap — no full-current EDB0, no timeout
  const gatedCapSentAtMs = 750 + IDENTICAL_SETTER_GATE_MS;
  stepAt(simulation, gatedCapSentAtMs, sentAt(simulation, "MUCHGC0100", gatedCapSentAtMs));
  const capCommitAtMs = gatedCapSentAtMs + 12_000;
  holdsAtEveryStep(simulation, gatedCapSentAtMs + 250, capCommitAtMs + 1_500, atMs => ({
    hallBatteryAmps: atMs < capCommitAtMs ? 280 : 11,
  }));
  stepAt(simulation, capCommitAtMs + 1_750, batsAt(simulation, 10, capCommitAtMs + 1_750));
  stepAt(simulation, capCommitAtMs + SETTLED_FOR_MS, {});
  check(
    "…released 3 s after the gated cap commits, at 11 A",
    lastEvent(simulation, "released")?.afterMs === capCommitAtMs + SETTLED_FOR_MS - 8_000 &&
      lastEvent(simulation, "released")?.hallBatteryAmps === 11 &&
      lastEvent(simulation, "timed_out") === undefined,
    JSON.stringify(lastEvent(simulation, "released"))
  );
}

{
  // A window that ends 5 s after it started: EDB1 (acknowledged at 0.3 s) + MUCHGC2610 (0.6 s) commit at
  // ~6.5 s, after the end, while HECS still shows the pre-window "disabled" (its confirm is due at ~17 s).
  // Without the hold this was a one-step stop at full current.
  const simulation = buyingFor(preWindow);
  stepAt(simulation, 0, { gridChargingWanted: true });
  stepAt(simulation, 300, sentAt(simulation, "EDB1", 300));
  stepAt(simulation, 600, sentAt(simulation, "MUCHGC2610", 600));
  stepAt(simulation, 5_000, windowEnd);
  check(
    "window ends 5 s in with HECS still pre-window 'disabled' → step-down starts, EDB0 held",
    kindsAt(simulation, 5_000).join() === "started" && holdsAcChargingOn(simulation.state)
  );
  stepAt(simulation, 5_400, sentAt(simulation, "MUCHGC0100", 5_400));
  // #62's gap 0 could poll HECS before EDB1 commits: that "disabled" can't rule out the unproven EDB1
  stepAt(simulation, 6_000, hecsAt(simulation, "disabled", 6_000));
  check("…a 'disabled' with EDB1 still unproven can't cancel it", holdsAcChargingOn(simulation.state));
  stepAt(simulation, 6_600, { hallBatteryAmps: 270 });
  // MUCHGC0100 commits at 11.4 s; the shared confirm at 17.4 s shows "enabled" and 10 A — and 10 A after
  // 10 → 261 → 10 can't tell whether MUCHGC2610 is still to land: the alternate cap settles it
  stepAt(simulation, 11_400, { hallBatteryAmps: 11 });
  const heldUntilConfirm = holdsAtEveryStep(simulation, 11_500, 17_250, () => ({}));
  stepAt(simulation, 17_400, { ...hecsAt(simulation, "enabled", 17_400), ...batsAt(simulation, 10, 17_400) });
  stepAt(simulation, 17_700, sentAt(simulation, "MUCHGC0090", 17_700));
  stepAt(simulation, 23_700, { hallBatteryAmps: 9 });
  stepAt(simulation, 29_700, batsAt(simulation, 9, 29_700));
  check(
    "…released only on the alternate cap's 9 A confirm, 24.7 s after the end",
    heldUntilConfirm &&
      lastEvent(simulation, "ambiguous_limit_readback")?.afterMs === 12_400 &&
      lastEvent(simulation, "released")?.afterMs === 24_700,
    JSON.stringify(lastEvent(simulation, "released"))
  );

  // The same under gap 0: the cap's interleaved confirm reads 10 A at 11.5 s, the alternate cap goes out at
  // once and its first re-check, 6 s later, reads 9 A
  const gapZero = buyingFor(preWindow);
  stepAt(gapZero, 0, { gridChargingWanted: true });
  stepAt(gapZero, 300, sentAt(gapZero, "EDB1", 300));
  stepAt(gapZero, 600, sentAt(gapZero, "MUCHGC2610", 600));
  stepAt(gapZero, 5_000, windowEnd);
  stepAt(gapZero, 5_400, sentAt(gapZero, "MUCHGC0100", 5_400));
  stepAt(gapZero, 6_600, { hallBatteryAmps: 270 });
  stepAt(gapZero, 11_400, { hallBatteryAmps: 11 });
  stepAt(gapZero, 11_500, batsAt(gapZero, 10, 11_500));
  stepAt(gapZero, 11_800, sentAt(gapZero, "MUCHGC0090", 11_800));
  stepAt(gapZero, 17_800, { hallBatteryAmps: 9, ...batsAt(gapZero, 9, 17_800) });
  check(
    "gap 0, window ending 5 s in: released at the alternate cap's first re-check, 12.8 s after the end",
    lastEvent(gapZero, "ambiguous_limit_readback")?.afterMs === 6_500 &&
      lastEvent(gapZero, "released")?.afterMs === 12_800,
    JSON.stringify(lastEvent(gapZero, "released"))
  );
}

{
  // The planner shrinks the running window to end now, 3 s after an in-window MUCHGC2550: the shared
  // confirm at +12.5 s still shows 255 A (MUCHGC0100 not committed yet), the retry at +42.5 s shows 10 A
  const simulation = buyingFor(nightBuying);
  stepAt(simulation, -2_700, sentAt(simulation, "MUCHGC2550", -2_700));
  endWindow(simulation);
  stepAt(simulation, CONFIRM_AFTER_WRITE_MS, batsAt(simulation, 255, CONFIRM_AFTER_WRITE_MS));
  const heldUntilRetry = holdsAtEveryStep(simulation, 12_750, 42_250, atMs => ({
    hallBatteryAmps: atMs < 30_000 ? 270 : 11,
  }));
  stepAt(simulation, 42_500, batsAt(simulation, 10, 42_500));
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
  stepAt(simulation, 100_300, batsAt(simulation, 10, 100_300));
  stepAt(simulation, 100_600, sentAt(simulation, "MUCHGC2610", 100_600));
  stepAt(simulation, 105_000, { ...windowEnd, hallBatteryAmps: 11 });
  stepAt(simulation, 105_500, sentAt(simulation, "MUCHGC0100", 105_500));
  stepAt(simulation, 110_000, {});
  check(
    "a 10 A readback from before the last higher-limit write doesn't count, even with the hall low",
    holdsAcChargingOn(simulation.state) &&
      lastEvent(simulation, "limit_confirmed") === undefined &&
      lastEvent(simulation, "ambiguous_limit_readback") === undefined
  );
}

{
  // A new buy window starts after EDB0 was released, before its HECS confirm
  const simulation = buyingFor(nightBuying);
  endWindow(simulation);
  stepAt(simulation, 6_500, { hallBatteryAmps: 11 });
  stepAt(simulation, CONFIRM_AFTER_WRITE_MS, batsAt(simulation, 10, CONFIRM_AFTER_WRITE_MS));
  stepAt(simulation, 12_800, sentAt(simulation, "EDB0", 12_800));
  stepAt(simulation, 15_000, { gridChargingWanted: true });
  check(
    "new window right after the release → superseded, back to idle (EDB1 desired again)",
    kindsAt(simulation, 15_000).join() === "release_superseded" && simulation.state.progress.phase === "idle"
  );
  // The new window's EDB1 and MUCHGC2500 go out; EDB0 had gone out but its commit never showed, so the
  // window ends with HECS still "enabled"
  stepAt(simulation, 15_300, sentAt(simulation, "EDB1", 15_300));
  stepAt(simulation, 15_600, sentAt(simulation, "MUCHGC2500", 15_600));
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
  stepAt(simulation, 300, sentAt(simulation, "EDB1", 300));
  stepAt(simulation, 600, sentAt(simulation, "MUCHGC2610", 600));
  stepAt(simulation, 5_000, { ...windowEnd, hallBatteryAmps: 11 });
  stepAt(simulation, 5_400, sentAt(simulation, "MUCHGC0100", 5_400));
  stepAt(simulation, 17_400, batsAt(simulation, 10, 17_400));
  stepAt(simulation, 17_700, sentAt(simulation, "MUCHGC0090", 17_700));
  stepAt(simulation, 29_700, batsAt(simulation, 9, 29_700));
  stepAt(simulation, 30_000, sentAt(simulation, "EDB0", 30_000));
  const restartedOnStaleHecs = heldAtAnyStep(simulation, 30_250, 41_000, () => ({}));
  check(
    "released on a stale 'disabled' → stays released, never restarts a step-down",
    simulation.state.progress.phase === "released" &&
      !restartedOnStaleHecs &&
      simulation.events.filter(recorded => recorded.event.kind === "started").length === 1
  );
  stepAt(simulation, 42_000, hecsAt(simulation, "disabled", 42_000));
  stepAt(simulation, 50_000, {});
  check(
    "…EDB0's own HECS confirm ends it, and idle stays idle (EDB0 is the flag's last write, after EDB1)",
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
  // fresh session's chains are empty. At boot MUCHGC0100 goes out first, its confirm comes before the
  // first settings poll's HECS.
  const simulation = bootedWithHallAt(280);
  stepAt(simulation, 0, {});
  check(
    "boot before any readback: nothing held, EDB effect waits for HECS anyway",
    !holdsAcChargingOn(simulation.state)
  );
  stepAt(simulation, 600, sentAt(simulation, "MUCHGC0100", 600));
  stepAt(simulation, 6_600, { hallBatteryAmps: 11 });
  stepAt(simulation, 12_600, batsAt(simulation, 10, 12_600));
  stepAt(simulation, 14_000, hecsAt(simulation, "enabled", 14_000));
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
  stepAt(notYetCommitted, 600, sentAt(notYetCommitted, "MUCHGC0100", 600));
  stepAt(notYetCommitted, 12_600, batsAt(notYetCommitted, 261, 12_600));
  stepAt(notYetCommitted, 14_000, hecsAt(notYetCommitted, "enabled", 14_000));
  stepAt(notYetCommitted, 30_000, {});
  check("boot with the old 261 A still in BATS → held", holdsAcChargingOn(notYetCommitted.state));
  stepAt(notYetCommitted, 40_000, { hallBatteryAmps: 12 });
  stepAt(notYetCommitted, 42_600, batsAt(notYetCommitted, 10, 42_600));
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
