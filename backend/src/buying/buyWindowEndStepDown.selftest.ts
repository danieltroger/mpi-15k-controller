/**
 * Pure self-test of the buy-window end step-down, main paths: EDB0 only once the 10 A cap has really
 * taken effect — a BATS readback at the cap with no unproven higher-limit write left in #62's write chain,
 * and the hall — at night, with PV, at #48's quiet gap and #62's gap 0, when the confirm gives up, without
 * a hall sensor, and the timeout and its extension when the hall shows the cap isn't in effect.
 * The released phase's EDB0 retries: buyWindowEndRelease.selftest.ts. Window extensions, shrinks, new
 * windows, restarts and readback races: buyWindowEndStepDownEdgeCases.selftest.ts. A→B→A readbacks and the
 * chain's trust window: buyWindowEndStepDownChains.selftest.ts.
 * Run from backend/ with:  yarn node src/buying/buyWindowEndStepDown.selftest.ts
 */
import process from "process";
import {
  acChargingLimitReassertions,
  alternateCapRequests,
  type BuyWindowEndInputs,
  holdsAcChargingOn,
  initialBuyWindowEndStepDownState,
  STEP_DOWN_EXTENSION_MS,
  STEP_DOWN_TIMEOUT_MS,
  wantedAcChargingLimitAmps,
} from "./buyWindowEndStepDown.ts";
import {
  allowedHallAmps,
  ALTERNATE_CAP_AMPS,
  HALL_ALLOWANCE_ABOVE_IDLE_LIMIT_AMPS,
  IDLE_AC_CHARGING_LIMIT_AMPS,
  SETTLED_FOR_MS,
} from "./buyWindowEndEvidence.ts";
import { MAX_LIMIT_REASSERTIONS } from "./buyWindowEndAsks.ts";
import {
  batsAt,
  buyingFor,
  CAP_SENT_AFTER_END_MS,
  COMMIT_AFTER_WRITE_MS,
  CONFIRM_AFTER_WRITE_MS,
  endWindow,
  eventsAfter,
  hecsAt,
  heldAtAnyStep,
  holdsAtEveryStep,
  kindsAt,
  lastEvent,
  nightBuying,
  sentAt,
  stepAt,
} from "./buyWindowEndStepDownSimulation.ts";

const failedChecks: string[] = [];

check("constants: idle cap is MUCHGC0100's 10 A", IDLE_AC_CHARGING_LIMIT_AMPS === 10);
check(
  "constants: timeout ~2 min, extension 60 s, the alternate cap one step below the idle cap",
  STEP_DOWN_TIMEOUT_MS === 120_000 && STEP_DOWN_EXTENSION_MS === 60_000 && ALTERNATE_CAP_AMPS === 9
);
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
  endWindow(simulation);
  check("window end: the step-down starts at once", kindsAt(simulation, 0).join() === "started");
  check("window end: AC charging is held on (EDB0 held back) in the same step", holdsAcChargingOn(simulation.state));
  const holdsUntilConfirm = holdsAtEveryStep(simulation, 750, CONFIRM_AFTER_WRITE_MS - 250, atMs => ({
    hallBatteryAmps: atMs < CAP_SENT_AFTER_END_MS + COMMIT_AFTER_WRITE_MS ? 280 : 11,
  }));
  check("hall already at 11 A for 6 s but no BATS readback yet → still holding", holdsUntilConfirm);
  stepAt(simulation, CONFIRM_AFTER_WRITE_MS, batsAt(simulation, 10, CONFIRM_AFTER_WRITE_MS));
  check(
    "BATS 10 A proving the cap's write landed, the hall settled for 6 s → confirmed and released in the same step",
    kindsAt(simulation, CONFIRM_AFTER_WRITE_MS).join() === "limit_confirmed,released" &&
      !holdsAcChargingOn(simulation.state)
  );
  const released = lastEvent(simulation, "released");
  check(
    "…with the timings logged",
    released?.afterMs === CONFIRM_AFTER_WRITE_MS &&
      released.limitConfirmedAfterMs === CONFIRM_AFTER_WRITE_MS &&
      released.hallSettledForMs === CONFIRM_AFTER_WRITE_MS - CAP_SENT_AFTER_END_MS - COMMIT_AFTER_WRITE_MS &&
      released.allowedHallAmps === 30,
    JSON.stringify(released)
  );
  // EDB0 goes out; its HECS confirm lands after the next quiet gap. Until then HECS still says "enabled".
  stepAt(simulation, 12_800, sentAt(simulation, "EDB0", 12_800));
  const heldOnStaleHecs = heldAtAnyStep(simulation, 13_000, 25_000, () => ({ hallBatteryAmps: 0 }));
  check(
    "the stale HECS 'enabled' before EDB0's confirm doesn't start another step-down",
    !heldOnStaleHecs && simulation.state.progress.phase === "released" && eventsAfter(simulation, 12_600).length === 0
  );
  stepAt(simulation, 25_500, hecsAt(simulation, "disabled", 25_500));
  const disabledConfirmed = lastEvent(simulation, "ac_charging_disabled_confirmed");
  check(
    "HECS shows AC charging off → back to idle, logged with timings",
    simulation.state.progress.phase === "idle" &&
      disabledConfirmed?.afterMs === 25_500 &&
      disabledConfirmed.afterReleaseMs === 25_500 - CONFIRM_AFTER_WRITE_MS
  );
}

{
  // A real window's amps wiggle, so its last higher-limit write can be seconds before the end (here
  // MUCHGC2600 at -3 s, still unproven). Its value differs from the cap's, so a 10 A readback can only
  // mean both landed, in send order: proof at the first readback, whatever the quiet gap.
  const quietGap = buyingFor(nightBuying);
  stepAt(quietGap, -3_000, sentAt(quietGap, "MUCHGC2600", -3_000));
  endWindow(quietGap);
  holdsAtEveryStep(quietGap, 750, CONFIRM_AFTER_WRITE_MS - 250, atMs => ({
    hallBatteryAmps: atMs < CAP_SENT_AFTER_END_MS + COMMIT_AFTER_WRITE_MS ? 280 : 11,
  }));
  stepAt(quietGap, CONFIRM_AFTER_WRITE_MS, batsAt(quietGap, 10, CONFIRM_AFTER_WRITE_MS));
  check(
    "quiet gap, last higher-limit write 3 s before the end → released at the confirm",
    lastEvent(quietGap, "released")?.afterMs === CONFIRM_AFTER_WRITE_MS
  );
  // #62's gap 0: the interleaved confirm reads 10 A 6 s after the cap went out — proof at once, so the
  // release only waits for the hall's 3 s settle, no fixed margin past the last higher-limit write
  const gapZero = buyingFor(nightBuying);
  stepAt(gapZero, -3_000, sentAt(gapZero, "MUCHGC2600", -3_000));
  endWindow(gapZero);
  const firstRecheckAtMs = CAP_SENT_AFTER_END_MS + COMMIT_AFTER_WRITE_MS;
  stepAt(gapZero, firstRecheckAtMs, { hallBatteryAmps: 11, ...batsAt(gapZero, 10, firstRecheckAtMs) });
  const heldWhileSettling = holdsAtEveryStep(gapZero, firstRecheckAtMs + 250, firstRecheckAtMs + 2_750, () => ({}));
  stepAt(gapZero, firstRecheckAtMs + SETTLED_FOR_MS, {});
  check(
    "gap 0: the 6.5 s re-check proves the cap; released 3 s later, once the hall has settled",
    heldWhileSettling &&
      lastEvent(gapZero, "limit_confirmed")?.afterMs === firstRecheckAtMs &&
      lastEvent(gapZero, "released")?.afterMs === firstRecheckAtMs + SETTLED_FOR_MS
  );
}

{
  // The cap shows in BATS but the battery keeps taking 280 A: the cap is demonstrably not in effect
  const simulation = buyingFor(nightBuying);
  endWindow(simulation);
  stepAt(simulation, CONFIRM_AFTER_WRITE_MS, batsAt(simulation, 10, CONFIRM_AFTER_WRITE_MS));
  const heldUntilTimeout = holdsAtEveryStep(simulation, 13_000, STEP_DOWN_TIMEOUT_MS - 1, () => ({}));
  check("hall stuck at 280 A with BATS at 10 A → held right up to the timeout", heldUntilTimeout);
  stepAt(simulation, STEP_DOWN_TIMEOUT_MS, {});
  const extended = lastEvent(simulation, "hold_extended");
  check(
    "…at the timeout the hall above the allowance extends the hold (errorLog) and asks for the alternate cap at once",
    holdsAcChargingOn(simulation.state) &&
      extended?.afterMs === STEP_DOWN_TIMEOUT_MS &&
      extended.hallBatteryAmps === 280 &&
      extended.limitEvidence === "shows_cap" &&
      alternateCapRequests(simulation.state) === 1,
    JSON.stringify(extended)
  );
  // A readback in the extension showing the real 261 A (the re-assert budget still unspent here) must not
  // re-queue MUCHGC0100: it would replace the alternate cap in the session queue
  stepAt(simulation, 120_300, sentAt(simulation, "MUCHGC0090", 120_300));
  stepAt(simulation, 150_000, batsAt(simulation, 261, 150_000));
  check(
    "…a 261 A readback during the extension re-asserts nothing over the alternate cap",
    lastEvent(simulation, "limit_reasserted") === undefined &&
      acChargingLimitReassertions(simulation.state) === 0 &&
      alternateCapRequests(simulation.state) === 1
  );
  const extendedDeadlineMs = STEP_DOWN_TIMEOUT_MS + STEP_DOWN_EXTENSION_MS;
  const heldThroughExtension = holdsAtEveryStep(simulation, 150_250, extendedDeadlineMs - 1, () => ({}));
  stepAt(simulation, extendedDeadlineMs, {});
  const timedOut = lastEvent(simulation, "timed_out");
  check(
    "…held through the extension, then EDB0 regardless — flagged as going out at full current",
    heldThroughExtension &&
      !holdsAcChargingOn(simulation.state) &&
      timedOut?.afterMs === extendedDeadlineMs &&
      timedOut.hallAboveAllowance &&
      simulation.events.filter(recorded => recorded.event.kind === "hold_extended").length === 1,
    JSON.stringify(timedOut)
  );
  // No BATS after the cap went out, the hall low (a full pack takes no current): EDB0 stops nothing, and
  // nothing above the cap is left unproven — the timeout says the hall vouched for it
  const fullPack = buyingFor({ ...nightBuying, hallBatteryAmps: 4 });
  endWindow(fullPack);
  stepAt(fullPack, STEP_DOWN_TIMEOUT_MS, {});
  const fullPackTimeout = lastEvent(fullPack, "timed_out");
  check(
    "no readback since the cap went out, hall low → plain timeout at 120 s (warn), hall-vouched, no extension",
    fullPackTimeout?.afterMs === STEP_DOWN_TIMEOUT_MS &&
      !fullPackTimeout.hallAboveAllowance &&
      fullPackTimeout.limitEvidence === "shows_higher_limit" &&
      fullPackTimeout.hallSettledForMs === STEP_DOWN_TIMEOUT_MS &&
      !fullPackTimeout.higherLimitMayLand &&
      lastEvent(fullPack, "hold_extended") === undefined,
    JSON.stringify(fullPackTimeout)
  );
  // The review's deadline tick: the step that extends the hold is the one a fresh 261 A BATS triggers,
  // with the re-assert still unspent — it must extend without re-asserting MUCHGC0100 over the 0090
  const deadlineTick = buyingFor(nightBuying);
  endWindow(deadlineTick);
  holdsAtEveryStep(deadlineTick, 750, STEP_DOWN_TIMEOUT_MS - 250, () => ({}));
  stepAt(deadlineTick, STEP_DOWN_TIMEOUT_MS, batsAt(deadlineTick, 261, STEP_DOWN_TIMEOUT_MS));
  check(
    "a 261 A readback on the deadline's own step extends the hold and re-asserts nothing",
    kindsAt(deadlineTick, STEP_DOWN_TIMEOUT_MS).join() === "hold_extended" &&
      acChargingLimitReassertions(deadlineTick.state) === 0 &&
      alternateCapRequests(deadlineTick.state) === 1,
    kindsAt(deadlineTick, STEP_DOWN_TIMEOUT_MS).join()
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
  endWindow(simulation);
  holdsAtEveryStep(simulation, 750, CONFIRM_AFTER_WRITE_MS - 250, atMs => ({
    hallBatteryAmps: atMs < CAP_SENT_AFTER_END_MS + COMMIT_AFTER_WRITE_MS ? 380 : 120,
  }));
  stepAt(simulation, CONFIRM_AFTER_WRITE_MS, batsAt(simulation, 10, CONFIRM_AFTER_WRITE_MS));
  check(
    "6 kW PV, hall 120 A (≤ 10 + 20 + 111 A) → released at the BATS confirm like at night",
    lastEvent(simulation, "released")?.afterMs === CONFIRM_AFTER_WRITE_MS
  );
  // The same hall without the PV term in the allowance would wait for the timeout
  const simulationWithoutPv = buyingFor({ ...sunnyBuying, solarWatts: 0 });
  endWindow(simulationWithoutPv);
  holdsAtEveryStep(simulationWithoutPv, 750, CONFIRM_AFTER_WRITE_MS - 250, atMs => ({
    hallBatteryAmps: atMs < CAP_SENT_AFTER_END_MS + COMMIT_AFTER_WRITE_MS ? 380 : 120,
  }));
  stepAt(simulationWithoutPv, CONFIRM_AFTER_WRITE_MS, batsAt(simulationWithoutPv, 10, CONFIRM_AFTER_WRITE_MS));
  check(
    "…(control: the same 120 A with PV unaccounted would still hold)",
    holdsAcChargingOn(simulationWithoutPv.state)
  );
}

{
  // The session's MUCHGC0100 confirm gives up (readback still 261 A at +12.5 s and +42.5 s); the buying
  // module re-queues the target once, so it goes out again at +60.5 s
  const simulation = buyingFor(nightBuying);
  endWindow(simulation);
  stepAt(simulation, CONFIRM_AFTER_WRITE_MS, batsAt(simulation, 261, CONFIRM_AFTER_WRITE_MS));
  stepAt(simulation, 42_500, batsAt(simulation, 261, 42_500));
  stepAt(simulation, 60_500, sentAt(simulation, "MUCHGC0100", 60_500));
  const heldThroughGiveUp = holdsAtEveryStep(simulation, 60_750, 72_000, atMs => ({
    hallBatteryAmps: atMs < 60_500 + COMMIT_AFTER_WRITE_MS ? 280 : 12,
  }));
  check("confirm gave up, limit still 261 A → held", heldThroughGiveUp);
  const reassertions = simulation.events.filter(recorded => recorded.event.kind === "limit_reasserted");
  check(
    `the first 261 A readback re-asserts the cap, later ones don't (max ${MAX_LIMIT_REASSERTIONS})`,
    reassertions.length === 1 &&
      reassertions[0]?.atMs === CONFIRM_AFTER_WRITE_MS &&
      acChargingLimitReassertions(simulation.state) === MAX_LIMIT_REASSERTIONS
  );
  stepAt(simulation, 72_500, batsAt(simulation, 10, 72_500));
  check(
    "…the re-sent MUCHGC0100 confirms at +72.5 s → released then, inside the timeout",
    lastEvent(simulation, "released")?.afterMs === 72_500
  );

  // A cap the inverter never applies (as 0100 nor 0090): the hall stays at 280 A, so the timeout extends
  // the hold and asks for the alternate cap; a 261 A readback in the extension doesn't re-queue MUCHGC0100
  // (it would replace the alternate cap in the session queue); EDB0 goes out at the extended deadline
  const extendedDeadlineMs = STEP_DOWN_TIMEOUT_MS + STEP_DOWN_EXTENSION_MS;
  const neverApplied = buyingFor(nightBuying);
  endWindow(neverApplied);
  stepAt(neverApplied, CONFIRM_AFTER_WRITE_MS, batsAt(neverApplied, 261, CONFIRM_AFTER_WRITE_MS));
  holdsAtEveryStep(neverApplied, 13_000, STEP_DOWN_TIMEOUT_MS, () => ({}));
  const alternateCapAsked = alternateCapRequests(neverApplied.state) === 1;
  stepAt(neverApplied, 120_300, sentAt(neverApplied, "MUCHGC0090", 120_300));
  stepAt(neverApplied, 150_000, batsAt(neverApplied, 261, 150_000));
  const heldWhileNeverApplied = holdsAtEveryStep(neverApplied, 150_250, extendedDeadlineMs - 250, () => ({}));
  stepAt(neverApplied, extendedDeadlineMs, {});
  const timedOut = lastEvent(neverApplied, "timed_out");
  const reassertedAt = neverApplied.events
    .filter(recorded => recorded.event.kind === "limit_reasserted")
    .map(recorded => recorded.atMs);
  check(
    "never-applied cap: held 120 s + 60 s, re-asserted once at 12.5 s, the alternate cap asked for, then EDB0 flagged",
    alternateCapAsked &&
      heldWhileNeverApplied &&
      !holdsAcChargingOn(neverApplied.state) &&
      reassertedAt.join() === "12500" &&
      timedOut?.afterMs === extendedDeadlineMs &&
      timedOut.limitEvidence === "shows_higher_limit" &&
      timedOut.hallAboveAllowance,
    `re-asserted at ${reassertedAt.join()}`
  );
}

{
  // current_measuring disabled or erroring: the proven readback alone vouches for the cap, after the settle
  const simulation = buyingFor({ ...nightBuying, hallBatteryAmps: undefined });
  endWindow(simulation);
  stepAt(simulation, CONFIRM_AFTER_WRITE_MS, batsAt(simulation, 10, CONFIRM_AFTER_WRITE_MS));
  stepAt(simulation, CONFIRM_AFTER_WRITE_MS + SETTLED_FOR_MS - 1, {});
  check("no hall: held during the settle after the readback", holdsAcChargingOn(simulation.state));
  stepAt(simulation, CONFIRM_AFTER_WRITE_MS + SETTLED_FOR_MS, {});
  check(
    "no hall: released on the readback alone after the settle, flagged as such",
    kindsAt(simulation, CONFIRM_AFTER_WRITE_MS + SETTLED_FOR_MS).join() === "released_without_hall" &&
      !holdsAcChargingOn(simulation.state)
  );
  // …but not a readback a higher-limit write may still overturn: the window was raised from the cap 3 s
  // before its end, so "10 A" can mean nothing landed yet. The alternate cap is asked for; it never shows.
  const raisedLate = buyingFor({
    ...nightBuying,
    limitReadback: { amps: 10, observedAtMs: -60_000 },
    hallBatteryAmps: undefined,
  });
  stepAt(raisedLate, -3_000, sentAt(raisedLate, "MUCHGC2610", -3_000));
  endWindow(raisedLate);
  stepAt(raisedLate, CONFIRM_AFTER_WRITE_MS, batsAt(raisedLate, 10, CONFIRM_AFTER_WRITE_MS));
  const heldWhileUnproven = holdsAtEveryStep(raisedLate, 12_750, STEP_DOWN_TIMEOUT_MS - 250, () => ({}));
  stepAt(raisedLate, STEP_DOWN_TIMEOUT_MS, {});
  const timedOut = lastEvent(raisedLate, "timed_out");
  check(
    "no hall, readback a higher write may still overturn → held, then a plain timeout (no hall to extend on)",
    heldWhileUnproven &&
      lastEvent(raisedLate, "ambiguous_limit_readback")?.unprovenHigherLimitsAmps.join() === "261" &&
      timedOut?.limitEvidence === "higher_limit_unproven" &&
      timedOut.higherLimitMayLand &&
      lastEvent(raisedLate, "hold_extended") === undefined,
    JSON.stringify(timedOut)
  );
}

{
  // Hall ringing around the commit (287 → 6 → 39 → 22 A, 2026-04-03): a sample above the allowance
  // restarts the settle clock
  const simulation = buyingFor(nightBuying);
  endWindow(simulation);
  stepAt(simulation, 6_500, { hallBatteryAmps: 6 });
  stepAt(simulation, CONFIRM_AFTER_WRITE_MS, batsAt(simulation, 10, CONFIRM_AFTER_WRITE_MS));
  check("released when settled ≥ 3 s at the confirm", !holdsAcChargingOn(simulation.state));
  const ringing = buyingFor(nightBuying);
  endWindow(ringing);
  stepAt(ringing, 6_500, { hallBatteryAmps: 6 });
  stepAt(ringing, 11_000, { hallBatteryAmps: 39 });
  stepAt(ringing, 11_250, { hallBatteryAmps: 22 });
  stepAt(ringing, CONFIRM_AFTER_WRITE_MS, batsAt(ringing, 10, CONFIRM_AFTER_WRITE_MS));
  check("a 39 A sample 1.5 s before the confirm → still settling", holdsAcChargingOn(ringing.state));
  stepAt(ringing, 14_250, {});
  check(
    "…released 3 s after the ringing ended",
    lastEvent(ringing, "released")?.afterMs === 14_250 && lastEvent(ringing, "released")?.hallSettledForMs === 3_000
  );
}

{
  // A window that only ever charged at the idle cap or below: nothing above the cap was ever written, so
  // the readback proves the cap at once — the window-end MUCHGC0100 is a cap too
  const simulation = buyingFor({
    ...nightBuying,
    limitReadback: { amps: 8, observedAtMs: -300_000 },
    hallBatteryAmps: 9,
  });
  endWindow(simulation);
  check("8 A window: confirmed at once", kindsAt(simulation, 0).join() === "started,limit_confirmed");
  stepAt(simulation, SETTLED_FOR_MS, {});
  check("…released after the 3 s settle", lastEvent(simulation, "released")?.afterMs === SETTLED_FOR_MS);
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
