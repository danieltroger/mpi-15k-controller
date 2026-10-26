/**
 * Pure self-test of the buy-window end step-down, main paths: EDB0 only once the 10 A cap has really
 * taken effect — at night, with PV, with #48's quiet gap and #62's gap 0, when the confirm gives up,
 * without a hall sensor, and the timeout and its extension when the hall shows the cap isn't in effect.
 * The released phase's EDB0 retries: buyWindowEndRelease.selftest.ts. Window extensions, shrinks, new
 * windows, restarts and readback races: buyWindowEndStepDownEdgeCases.selftest.ts.
 * Run from backend/ with:  yarn node src/buying/buyWindowEndStepDown.selftest.ts
 */
import process from "process";
import {
  acChargingLimitReassertions,
  allowedHallAmps,
  type BuyWindowEndInputs,
  HALL_ALLOWANCE_ABOVE_IDLE_LIMIT_AMPS,
  holdsAcChargingOn,
  IDLE_AC_CHARGING_LIMIT_AMPS,
  initialBuyWindowEndStepDownState,
  lastRelevantSends,
  MAX_LIMIT_REASSERTIONS,
  READBACK_COMMIT_MARGIN_MS,
  SETTLED_FOR_MS,
  STEP_DOWN_EXTENSION_MS,
  STEP_DOWN_TIMEOUT_MS,
  wantedAcChargingLimitAmps,
} from "./buyWindowEndStepDown.ts";
import {
  buyingFor,
  COMMIT_AFTER_WRITE_MS,
  CONFIRM_AFTER_WRITE_MS,
  eventsAfter,
  hecs,
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
check(
  "constants: timeout ~2 min, extension one 180 s settings poll",
  STEP_DOWN_TIMEOUT_MS === 120_000 && STEP_DOWN_EXTENSION_MS === 180_000
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
{
  const sends = lastRelevantSends({
    MUCHGC2610: 5_000,
    MUCHGC2550: 7_000,
    MUCHGC0100: 9_000,
    EDB1: 3_000,
    EDB0: 8_000,
  });
  check(
    "send record: the latest MUCHGC above 10 A, and EDB1",
    sends.lastAboveIdleLimitSentAtMs === 7_000 && sends.lastAcChargingEnableSentAtMs === 3_000,
    JSON.stringify(sends)
  );
  const none = lastRelevantSends({ MUCHGC0100: 1_000, MUCHGC0050: 2_000 });
  check(
    "send record: caps at or below 10 A and no EDB1 → nothing relevant",
    none.lastAboveIdleLimitSentAtMs === undefined && none.lastAcChargingEnableSentAtMs === undefined
  );
}
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
  check("hall already at 11 A for 6 s but no BATS readback yet → still holding", holdsUntilConfirm);
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
  stepAt(simulation, 25_500, { acChargingReadback: hecs("disabled", 25_500) });
  const disabledConfirmed = lastEvent(simulation, "ac_charging_disabled_confirmed");
  check(
    "HECS shows AC charging off → back to idle, logged with timings",
    simulation.state.progress.phase === "idle" &&
      disabledConfirmed?.afterMs === 25_500 &&
      disabledConfirmed.afterReleaseMs === 25_500 - CONFIRM_AFTER_WRITE_MS
  );
}

{
  // A real window's amps wiggle, so its last higher-limit write can be seconds before the end
  // (here MUCHGC2600 acknowledged at -3 s). #48: the confirm at +12.5 s is past that write's horizon.
  const wiggling = { ...nightBuying, lastAboveIdleLimitSentAtMs: -3_000 };
  const quietGap = buyingFor(wiggling);
  stepAt(quietGap, 0, windowEnd);
  holdsAtEveryStep(quietGap, 250, CONFIRM_AFTER_WRITE_MS - 250, atMs => ({
    hallBatteryAmps: atMs < COMMIT_AFTER_WRITE_MS ? 280 : 11,
  }));
  stepAt(quietGap, CONFIRM_AFTER_WRITE_MS, { limitReadback: { amps: 10, observedAtMs: CONFIRM_AFTER_WRITE_MS } });
  check(
    "quiet gap, last higher-limit write 3 s before the end → released at the confirm",
    lastEvent(quietGap, "released")?.afterMs === CONFIRM_AFTER_WRITE_MS
  );
  // #62's gap 0: the interleaved confirm reads BATS 10 A at +7 s, inside that write's commit margin, and
  // no BATS follows until the 180 s settings poll — the hall has to carry the proof past the horizon
  const gapZero = buyingFor(wiggling);
  stepAt(gapZero, 0, windowEnd);
  stepAt(gapZero, 6_500, { hallBatteryAmps: 11 });
  stepAt(gapZero, 7_000, { limitReadback: { amps: 10, observedAtMs: 7_000 } });
  const horizonMs = -3_000 + READBACK_COMMIT_MARGIN_MS;
  const heldPastHorizon = holdsAtEveryStep(gapZero, 7_250, horizonMs + SETTLED_FOR_MS - 250, () => ({
    hallBatteryAmps: 11,
  }));
  stepAt(gapZero, horizonMs + SETTLED_FOR_MS, {});
  check(
    "gap 0: the +7 s readback is evidence, but release waits for the hall to settle 3 s past the horizon (+12 s), not the timeout",
    heldPastHorizon &&
      lastEvent(gapZero, "limit_confirmed")?.afterMs === 7_000 &&
      lastEvent(gapZero, "released")?.afterMs === horizonMs + SETTLED_FOR_MS
  );
}

{
  // The cap shows in BATS but the battery keeps taking 280 A: the cap is demonstrably not in effect
  const simulation = buyingFor(nightBuying);
  stepAt(simulation, 0, windowEnd);
  stepAt(simulation, CONFIRM_AFTER_WRITE_MS, { limitReadback: { amps: 10, observedAtMs: CONFIRM_AFTER_WRITE_MS } });
  const heldUntilTimeout = holdsAtEveryStep(simulation, 13_000, STEP_DOWN_TIMEOUT_MS - 1, () => ({}));
  check("hall stuck at 280 A with BATS at 10 A → held right up to the timeout", heldUntilTimeout);
  stepAt(simulation, STEP_DOWN_TIMEOUT_MS, {});
  const extended = lastEvent(simulation, "hold_extended");
  check(
    "…at the timeout the hall above the allowance extends the hold (errorLog) instead of sending EDB0",
    holdsAcChargingOn(simulation.state) &&
      extended?.afterMs === STEP_DOWN_TIMEOUT_MS &&
      extended.hallBatteryAmps === 280 &&
      extended.limitEvidence === "shows_cap",
    JSON.stringify(extended)
  );
  const extendedDeadlineMs = STEP_DOWN_TIMEOUT_MS + STEP_DOWN_EXTENSION_MS;
  const heldThroughExtension = holdsAtEveryStep(
    simulation,
    STEP_DOWN_TIMEOUT_MS + 250,
    extendedDeadlineMs - 1,
    () => ({})
  );
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
  // A cap that never shows but with the hall low (a full pack takes no current): EDB0 stops nothing
  const fullPack = buyingFor({ ...nightBuying, hallBatteryAmps: 4 });
  stepAt(fullPack, 0, windowEnd);
  stepAt(fullPack, STEP_DOWN_TIMEOUT_MS, {});
  const fullPackTimeout = lastEvent(fullPack, "timed_out");
  check(
    "no cap shown, hall low → plain timeout at 120 s (warn), no extension",
    fullPackTimeout?.afterMs === STEP_DOWN_TIMEOUT_MS &&
      !fullPackTimeout.hallAboveAllowance &&
      fullPackTimeout.limitEvidence === "shows_higher_limit" &&
      lastEvent(fullPack, "hold_extended") === undefined
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
  // module re-queues the target once, so it goes out again at +60.5 s
  const simulation = buyingFor(nightBuying);
  stepAt(simulation, 0, windowEnd);
  stepAt(simulation, CONFIRM_AFTER_WRITE_MS, { limitReadback: { amps: 261, observedAtMs: CONFIRM_AFTER_WRITE_MS } });
  stepAt(simulation, 42_500, { limitReadback: { amps: 261, observedAtMs: 42_500 } });
  const heldThroughGiveUp = holdsAtEveryStep(simulation, 42_750, 72_000, atMs => ({
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
  stepAt(simulation, 72_500, { limitReadback: { amps: 10, observedAtMs: 72_500 } });
  check(
    "…the re-sent MUCHGC0100 confirms at +72.5 s → released then, inside the timeout",
    lastEvent(simulation, "released")?.afterMs === 72_500
  );

  // A cap the inverter never applies: the hall stays at 280 A, so the timeout extends the hold, the next
  // settings poll's 261 A re-asserts once more, and EDB0 goes out only at the extended deadline
  const neverApplied = buyingFor(nightBuying);
  stepAt(neverApplied, 0, windowEnd);
  stepAt(neverApplied, CONFIRM_AFTER_WRITE_MS, { limitReadback: { amps: 261, observedAtMs: CONFIRM_AFTER_WRITE_MS } });
  holdsAtEveryStep(neverApplied, 13_000, STEP_DOWN_TIMEOUT_MS, () => ({}));
  stepAt(neverApplied, 180_000, { limitReadback: { amps: 261, observedAtMs: 180_000 } });
  stepAt(neverApplied, 240_000, { limitReadback: { amps: 261, observedAtMs: 240_000 } });
  const heldWhileNeverApplied = holdsAtEveryStep(neverApplied, 240_250, 299_750, () => ({}));
  stepAt(neverApplied, STEP_DOWN_TIMEOUT_MS + STEP_DOWN_EXTENSION_MS, {});
  const timedOut = lastEvent(neverApplied, "timed_out");
  const reassertedAt = neverApplied.events
    .filter(recorded => recorded.event.kind === "limit_reasserted")
    .map(recorded => recorded.atMs);
  check(
    "never-applied cap: held 120 s + 180 s, re-asserted at 12.5 s and once more in the extension, then EDB0 flagged",
    heldWhileNeverApplied &&
      !holdsAcChargingOn(neverApplied.state) &&
      reassertedAt.join() === "12500,180000" &&
      timedOut?.limitEvidence === "shows_higher_limit" &&
      timedOut.hallAboveAllowance,
    `re-asserted at ${reassertedAt.join()}`
  );
}

{
  // current_measuring disabled or erroring: only a readback beyond the commit horizon vouches for the cap
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
  // …a readback inside the last higher-limit write's horizon doesn't (gap 0 without a hall: the timeout)
  const insideHorizon = buyingFor({ ...nightBuying, hallBatteryAmps: undefined, lastAboveIdleLimitSentAtMs: -3_000 });
  stepAt(insideHorizon, 0, windowEnd);
  stepAt(insideHorizon, 7_000, { limitReadback: { amps: 10, observedAtMs: 7_000 } });
  const heldInsideHorizon = holdsAtEveryStep(insideHorizon, 7_250, STEP_DOWN_TIMEOUT_MS - 250, () => ({}));
  stepAt(insideHorizon, STEP_DOWN_TIMEOUT_MS, {});
  check(
    "no hall, readback inside the commit margin → held, then a plain timeout (no hall to extend on)",
    heldInsideHorizon &&
      lastEvent(insideHorizon, "timed_out")?.limitEvidence === "shows_cap" &&
      lastEvent(insideHorizon, "hold_extended") === undefined
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
  // A window that only ever charged at the idle cap or below: no higher-limit write, the readback proves it
  const simulation = buyingFor({
    ...nightBuying,
    lastAboveIdleLimitSentAtMs: undefined,
    limitReadback: { amps: 8, observedAtMs: -300_000 },
    hallBatteryAmps: 9,
  });
  stepAt(simulation, 0, windowEnd);
  check("8 A window: confirmed at once", kindsAt(simulation, 0).join() === "started,limit_confirmed");
  stepAt(simulation, SETTLED_FOR_MS, {});
  check("…released after the 3 s settle", lastEvent(simulation, "released")?.afterMs === SETTLED_FOR_MS);
}

{
  // Someone else disables AC charging (the inverter's LCD) mid-step-down: EDB1 went out long ago, so a
  // HECS "disabled" can't be one still racing it
  const simulation = buyingFor(nightBuying);
  stepAt(simulation, 0, windowEnd);
  stepAt(simulation, 8_000, { acChargingReadback: hecs("disabled", 8_000) });
  check(
    "AC charging off by other means → cancelled, nothing held",
    lastEvent(simulation, "cancelled")?.reason === "AC charging already disabled" &&
      !holdsAcChargingOn(simulation.state)
  );
  // …but within the commit margin of a recent EDB1 (the window started 3 s before it ended) it can be
  const recentEnable = buyingFor({ ...nightBuying, lastAcChargingEnableSentAtMs: -3_000 });
  stepAt(recentEnable, 0, windowEnd);
  stepAt(recentEnable, 8_000, { acChargingReadback: hecs("disabled", 8_000) });
  check("HECS 'disabled' 11 s after EDB1 went out → still held", holdsAcChargingOn(recentEnable.state));
  stepAt(recentEnable, 9_500, { acChargingReadback: hecs("disabled", 9_500) });
  check("…a 'disabled' 12.5 s after it → cancelled", !holdsAcChargingOn(recentEnable.state));
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
