/**
 * Self-test of the hold guard (holdWindowGuard.ts) and the buy schedule decision (scheduledBuyDecision.ts).
 * The guard drops out of a hold when a phase stays over the breaker level for 5 s, when the battery is too
 * cold for the hold's trickle, when its readings go stale or a phase has no grid; it resumes only after
 * hold_reentry_minutes comfortably below, after a controller start too; it never drops out without a hold
 * wanted; and it projects the per-phase grid current from the fuse logic's readings. With hold_enabled off,
 * the schedule decision is main's to the watt, whatever the window powers. Run from backend/ with:
 *   yarn node src/buying/holdWindowGuard.selftest.ts
 */
import process from "process";
import {
  dropOutAmps,
  type GridProjection,
  holdGuardMinBatteryCelsius,
  type HoldGuardReadings,
  type HoldGuardSettings,
  holdGuardStartState,
  type HoldGuardState,
  type HoldGuardTransition,
  OVERLOAD_CONFIRM_MS,
  projectedHoldGridAmps,
  READING_MAX_AGE_MS,
  stepHoldWindowGuard,
  type TimedReading,
} from "./holdWindowGuard.ts";
import { decideScheduledBuy, wattsForInverter } from "./scheduledBuyDecision.ts";

const failedChecks: string[] = [];
function check(name: string, passed: boolean, detail = "") {
  console.log(`${passed ? "PASS" : "FAIL"}: ${name} ${detail}`);
  if (!passed) failedChecks.push(name);
}

// The live config: 22 A max grid draw, the defaults for the rest (drop out at 20 A, resume below 18 A)
const SETTINGS: HoldGuardSettings = {
  maxGridInputAmps: 22,
  gridMarginAmps: 2,
  reentryMinutes: 15,
  reentryHysteresisAmps: 2,
  minBatteryCelsius: 5,
};
const SECOND_MS = 1000;
const MINUTE_MS = 60_000;
const ALLOWED: HoldGuardState = { phase: "allowed", overload: undefined };

function phases(r: number, s: number, t: number): GridProjection {
  return { status: "ok", ampsPerPhase: { r, s, t } };
}
const quietNight: HoldGuardReadings = { grid: phases(2.1, 1.4, 2.8), coldestBatteryCelsius: 11 };
// The EV charging (16 A per phase) over the house's base load: under the drop-out level, a hold may run
const evCharging: HoldGuardReadings = { grid: phases(17.2, 16.6, 17.0), coldestBatteryCelsius: 11 };
// … and a 2 kW kettle on L3 on top
const evAndKettle: HoldGuardReadings = { grid: phases(17.2, 16.6, 25.7), coldestBatteryCelsius: 11 };

/** Steps the guard every stepMs through the given readings; returns the states and transitions */
function run(
  readingsPerStep: HoldGuardReadings[],
  { holdWanted = true, from = ALLOWED, settings = SETTINGS, stepMs = SECOND_MS } = {}
): { states: HoldGuardState[]; transitions: (HoldGuardTransition | undefined)[] } {
  let state = from;
  const states: HoldGuardState[] = [];
  const transitions: (HoldGuardTransition | undefined)[] = [];
  readingsPerStep.forEach((readings, step) => {
    const result = stepHoldWindowGuard(state, { nowMs: step * stepMs, holdWanted, readings }, settings);
    state = result.state;
    states.push(state);
    transitions.push(result.transition);
  });
  return { states, transitions };
}

function repeat(readings: HoldGuardReadings, count: number): HoldGuardReadings[] {
  return Array.from({ length: count }, () => readings);
}

function droppedOutState(): HoldGuardState {
  return run(repeat(evAndKettle, 10)).states[9];
}

// ---------- Breakers ----------
{
  const { states, transitions } = run([...repeat(quietNight, 5), ...repeat(evCharging, 60)], { stepMs: MINUTE_MS });
  check(
    "a quiet night and the EV alone (17.2 A) keep the hold",
    states.every(state => state.phase === "allowed") && transitions.every(transition => !transition)
  );
}
{
  const confirmSteps = OVERLOAD_CONFIRM_MS / SECOND_MS;
  const { states, transitions } = run([...repeat(evCharging, 3), ...repeat(evAndKettle, confirmSteps + 2)]);
  const dropOutStep = transitions.findIndex(transition => transition?.kind === "dropped_out");
  const dropOut = transitions[dropOutStep];
  check(
    "the EV plus a kettle on L3 (25.7 A) drops out once it has lasted 5 s",
    dropOutStep === 3 + confirmSteps &&
      states[dropOutStep - 1].phase === "allowed" &&
      dropOut?.kind === "dropped_out" &&
      dropOut.cause === "overload" &&
      dropOut.reason.includes("phase T"),
    `(step ${dropOutStep}: ${dropOut?.kind === "dropped_out" ? dropOut.reason : "no drop-out"})`
  );
  const inrush = run([...repeat(evCharging, 3), ...repeat(evAndKettle, 2), ...repeat(evCharging, 30)]);
  check(
    "a 2 s inrush over the level keeps the hold (it needs 5 s), and the overload ends after 5 s below",
    inrush.states.every(state => state.phase === "allowed") &&
      inrush.states[34].phase === "allowed" &&
      !inrush.states[34].overload
  );
  // Readings a second apart: six below the level span the 5 s that end an overload (t = 1 … 6)
  const twoInrushes = run([evAndKettle, ...repeat(evCharging, 6), evAndKettle, ...repeat(evCharging, 20)]);
  check(
    "two inrushes with 5 s below between: the first overload ended, the hold stays",
    twoInrushes.states.every(state => state.phase === "allowed")
  );
  const closeInrushes = run([evAndKettle, ...repeat(evCharging, 5), evAndKettle, ...repeat(evCharging, 20)]);
  check(
    "two inrushes with only 4 s below between: one overload, 6 s old at the second, drops out (erring that way)",
    closeInrushes.transitions[6]?.kind === "dropped_out"
  );
  // The EV plus a kettle alternating with the EV alone every other reading: an overload, not two
  const flicker = run(Array.from({ length: 40 }, (_, step) => (step % 2 ? evCharging : evAndKettle)));
  const flickerDropStep = flicker.transitions.findIndex(transition => transition?.kind === "dropped_out");
  check(
    "an overload broken by every other reading (kettle on/off against the EV alone) drops out 5 s in",
    flickerDropStep === 6 &&
      flicker.transitions[6]?.kind === "dropped_out" &&
      flicker.transitions[6].cause === "overload",
    `(dropped out at step ${flickerDropStep})`
  );
  // A phase averaging ~20.4 A with one 19.8 A reading every 5 s: jitter around the level, not below it
  const jitter = run(
    Array.from(
      { length: 30 },
      (_, step): HoldGuardReadings => ({
        grid: phases(3, step % 5 === 4 ? 19.8 : 20.55, 3),
        coldestBatteryCelsius: 11,
      })
    )
  );
  const jitterDropStep = jitter.transitions.findIndex(transition => transition?.kind === "dropped_out");
  check(
    "a phase averaging 20.4 A with a 19.8 A dip every 5 s drops out 5 s in (the dips don't restart it)",
    jitterDropStep === 5 && jitter.transitions[5]?.kind === "dropped_out" && jitter.transitions[5].cause === "overload",
    `(dropped out at step ${jitterDropStep})`
  );
  // …while a phase that dips under the level and stays there for 5 s ends its overload
  const settles = run([
    ...repeat(evAndKettle, 3),
    ...repeat(evCharging, 6),
    ...repeat(evAndKettle, 3),
    ...repeat(evCharging, 20),
  ]);
  check(
    "3 s over, 5 s below, 3 s over: two short overloads, the hold stays",
    settles.states.every(state => state.phase === "allowed")
  );
}
{
  const atLimit: HoldGuardReadings = { grid: phases(3, dropOutAmps(SETTINGS), 3), coldestBatteryCelsius: 11 };
  const justBelow: HoldGuardReadings = { grid: phases(3, dropOutAmps(SETTINGS) - 0.01, 3), coldestBatteryCelsius: 11 };
  check(
    "exactly at max grid draw − margin (20 A) for 6 s drops out",
    run(repeat(atLimit, 7)).states[6].phase === "dropped_out"
  );
  check(
    "just below it holds",
    run(repeat(justBelow, 60)).states.every(state => state.phase === "allowed")
  );
}
{
  // Kettle on, then the EV alone: back in only after 15 min below 18 A
  const { states, transitions } = run([...repeat(evCharging, 20), ...repeat(evCharging, 30)], {
    from: droppedOutState(),
    stepMs: MINUTE_MS,
  });
  const resumedAtMinute = transitions.findIndex(transition => transition?.kind === "resumed");
  const resumed = transitions[resumedAtMinute];
  check(
    "after the kettle, the hold resumes 15 min after the load fell comfortably below the drop-out level",
    resumedAtMinute === SETTINGS.reentryMinutes &&
      states[resumedAtMinute - 1].phase === "dropped_out" &&
      resumed?.kind === "resumed" &&
      resumed.cause === "overload",
    `(resumed at minute ${resumedAtMinute})`
  );
}
{
  // Hovering between the re-entry and the drop-out level (18–20 A) stays out: no flapping
  const hovering: HoldGuardReadings = {
    grid: phases(dropOutAmps(SETTINGS) - SETTINGS.reentryHysteresisAmps / 2, 3, 3),
    coldestBatteryCelsius: 11,
  };
  const { states } = run(repeat(hovering, 40), { from: droppedOutState(), stepMs: MINUTE_MS });
  check(
    "a load hovering at 19 A (between 18 and 20 A) keeps the hold out",
    states.every(state => state.phase === "dropped_out")
  );
  // hold_reentry_hysteresis_amps 0.5: comfortably below is under 19.5 A, so 19 A resumes after the wait
  const narrow = run(repeat(hovering, 40), {
    from: droppedOutState(),
    stepMs: MINUTE_MS,
    settings: { ...SETTINGS, reentryHysteresisAmps: 0.5 },
  });
  check(
    "with a 0.5 A re-entry gap the same 19 A load resumes after the 15 min wait",
    narrow.transitions.findIndex(transition => transition?.kind === "resumed") === SETTINGS.reentryMinutes
  );
}
{
  const { transitions } = run([...repeat(evCharging, 10), evAndKettle, ...repeat(evCharging, 14)], {
    from: droppedOutState(),
    stepMs: MINUTE_MS,
  });
  check(
    "a load returning 10 min in restarts the 15 min count (no re-entry after 14 more)",
    transitions.every(transition => transition?.kind !== "resumed")
  );
}
{
  // Outside a hold window nothing drops out (a kettle between two windows mustn't log anything) …
  const { states, transitions } = run(repeat(evAndKettle, 30), { holdWanted: false });
  check(
    "no hold wanted: an overload drops nothing",
    states.every(state => state.phase === "allowed") && transitions.every(transition => !transition)
  );
  // … but a guard that dropped out clears once it's safe, so the next window starts held
  const cleared = run(repeat(quietNight, 16), { holdWanted: false, from: droppedOutState(), stepMs: MINUTE_MS });
  const clearing = cleared.transitions.find(transition => transition?.kind === "resumed");
  check(
    "dropped out, then the window ended: clears after 15 quiet minutes, saying no hold is wanted",
    cleared.states[15].phase === "allowed" && clearing?.kind === "resumed" && !clearing.holdWanted
  );
}

// ---------- Blind or without a grid: fail closed ----------
{
  const blind: HoldGuardReadings = {
    grid: { status: "missing", detail: "phase R's AC output or grid voltage is 75 s old" },
    coldestBatteryCelsius: 11,
  };
  const { transitions } = run([quietNight, blind]);
  check(
    "missing grid readings drop the hold out at once (the age limit is the delay)",
    transitions[1]?.kind === "dropped_out" && transitions[1].cause === "readings_missing"
  );
  const stillBlind = run(repeat(blind, 30), { from: droppedOutState(), stepMs: MINUTE_MS });
  check(
    "dropped out and blind: stays out",
    stillBlind.states.every(state => state.phase === "dropped_out")
  );
  const noGrid: HoldGuardReadings = {
    grid: { status: "no_grid", detail: "phase S reads 0 V: no grid" },
    coldestBatteryCelsius: 11,
  };
  const gridOff = run([quietNight, noGrid, ...repeat(noGrid, 20)]);
  check(
    "a phase without grid voltage drops out (as no_grid) and stays out",
    gridOff.transitions[1]?.kind === "dropped_out" &&
      gridOff.transitions[1].cause === "no_grid" &&
      gridOff.states.slice(1).every(state => state.phase === "dropped_out")
  );
}

// ---------- Freezing battery ----------
{
  const cold: HoldGuardReadings = { ...quietNight, coldestBatteryCelsius: 4.5 };
  const atMinimum: HoldGuardReadings = { ...quietNight, coldestBatteryCelsius: 5 };
  const justWarm: HoldGuardReadings = { ...quietNight, coldestBatteryCelsius: 5.5 };
  const warm: HoldGuardReadings = { ...quietNight, coldestBatteryCelsius: 6.5 };
  const coldOut = run([cold]).states[0];
  const dropOut = run([cold]).transitions[0];
  check(
    "the coldest battery probe at 4.5 °C (minimum 5) drops out at once",
    dropOut?.kind === "dropped_out" && dropOut.cause === "cold_battery",
    `(${dropOut?.kind === "dropped_out" ? dropOut.reason : "no drop-out"})`
  );
  check("at exactly the minimum it drops out too", run([atMinimum]).states[0].phase === "dropped_out");
  check(
    "5.5 °C is warm enough to hold, not to resume (needs > 6 °C)",
    run([justWarm]).states[0].phase === "allowed" &&
      run(repeat(justWarm, 30), { from: coldOut, stepMs: MINUTE_MS }).states.every(
        state => state.phase === "dropped_out"
      )
  );
  check(
    "6.5 °C for 15 min resumes",
    run(repeat(warm, 16), { from: coldOut, stepMs: MINUTE_MS }).states[15].phase === "allowed"
  );
  check(
    "no battery probe reading: the freezing P1 can't fire, the hold may run",
    run([{ ...quietNight, coldestBatteryCelsius: undefined }]).states[0].phase === "allowed"
  );
  check(
    "the hold minimum never comes within 1 °C of the freezing P1's threshold",
    holdGuardMinBatteryCelsius(5, 1) === 5 &&
      holdGuardMinBatteryCelsius(0, 1) === 2 &&
      holdGuardMinBatteryCelsius(3, 6) === 7
  );
}

// ---------- A controller start: out until 15 min of fresh, comfortable readings ----------
{
  const started = holdGuardStartState(0);
  const { states, transitions } = run(repeat(quietNight, 20), { from: started, stepMs: MINUTE_MS });
  const resumedAt = transitions.findIndex(transition => transition?.kind === "resumed");
  check(
    "after a start a wanted hold waits 15 min of comfortable readings, then starts",
    started.phase === "dropped_out" &&
      states.slice(0, 15).every(state => state.phase === "dropped_out") &&
      resumedAt === 15 &&
      transitions[resumedAt]?.kind === "resumed" &&
      transitions[resumedAt]?.cause === "controller_start"
  );
  // A crash loop restarting every 5 min never switches AC charging on
  const crashLoop = [0, 1, 2, 3].flatMap(
    () => run(repeat(quietNight, 5), { from: holdGuardStartState(0), stepMs: MINUTE_MS }).states
  );
  check(
    "a crash loop restarting every 5 min never lets the hold run",
    crashLoop.every(state => state.phase === "dropped_out")
  );
  const blindStart = run(repeat({ ...quietNight, grid: { status: "missing", detail: "never read" } }, 30), {
    from: holdGuardStartState(0),
    stepMs: MINUTE_MS,
  });
  check(
    "a start without readings never lets the hold run",
    blindStart.states.every(state => state.phase === "dropped_out")
  );
}

// ---------- Unchanged state stays the same object (a memo holding it doesn't notify) ----------
{
  const first = stepHoldWindowGuard(ALLOWED, { nowMs: 0, holdWanted: true, readings: quietNight }, SETTINGS);
  const second = stepHoldWindowGuard(
    first.state,
    { nowMs: MINUTE_MS, holdWanted: true, readings: quietNight },
    SETTINGS
  );
  check("a quiet tick returns the previous state object", second.state === first.state);
}

// ---------- The projection ----------
{
  const nowMs = 1_000_000;
  const at = (value: number, ageMs = 1000): TimedReading => ({ value, time: nowMs - ageMs });
  const volts = { r: at(230), s: at(230), t: at(230) };
  const active = { r: at(3680), s: at(460), t: at(920) };
  const projection = projectedHoldGridAmps({
    nowMs,
    activeWatts: active,
    apparentWatts: { r: at(3700), s: at(400), t: at(1000) },
    gridVolts: volts,
    inverterAndTrickleWatts: 140 + 100 + 100,
  });
  check(
    "per phase: the larger of active and apparent AC output plus a third of idle + overhead + trickle, over the voltage",
    projection.status === "ok" &&
      Math.abs(projection.ampsPerPhase.r - (3700 + 340 / 3) / 230) < 1e-9 &&
      Math.abs(projection.ampsPerPhase.s - (460 + 340 / 3) / 230) < 1e-9 &&
      Math.abs(projection.ampsPerPhase.t - (1000 + 340 / 3) / 230) < 1e-9,
    `(${JSON.stringify(projection)})`
  );
  const staleApparent = projectedHoldGridAmps({
    nowMs,
    activeWatts: active,
    apparentWatts: { r: at(9000, READING_MAX_AGE_MS + 1000), s: at(400), t: at(1000) },
    gridVolts: volts,
    inverterAndTrickleWatts: 0,
  });
  check(
    "a stale apparent power is left out (the active power counts)",
    staleApparent.status === "ok" && Math.abs(staleApparent.ampsPerPhase.r - 3680 / 230) < 1e-9
  );
  const stalledPoll = projectedHoldGridAmps({
    nowMs,
    activeWatts: { ...active, s: at(460, READING_MAX_AGE_MS + 1000) },
    apparentWatts: {},
    gridVolts: volts,
    inverterAndTrickleWatts: 0,
  });
  check(
    "an AC output older than 60 s (a stalled poll; the store never clears a value) is missing",
    stalledPoll.status === "missing" &&
      stalledPoll.detail.includes("phase S") &&
      stalledPoll.detail.includes("61 s old"),
    `(${JSON.stringify(stalledPoll)})`
  );
  check(
    "a phase never read is missing",
    projectedHoldGridAmps({
      nowMs,
      activeWatts: { r: at(100), s: at(100) },
      apparentWatts: {},
      gridVolts: volts,
      inverterAndTrickleWatts: 0,
    }).status === "missing"
  );
  const gridOff = projectedHoldGridAmps({
    nowMs,
    activeWatts: active,
    apparentWatts: {},
    gridVolts: { r: at(0), s: at(231), t: at(229) },
    inverterAndTrickleWatts: 340,
  });
  check(
    "a phase below 100 V: no grid (fails closed, never 0 A)",
    gridOff.status === "no_grid",
    `(${JSON.stringify(gridOff)})`
  );
}

// ---------- The schedule decision ----------
const gate = { only_buy_below_soc: 40, start_buying_again_below_soc: 15 };
{
  const hold = decideScheduledBuy({
    ...gate,
    scheduledWattsPerWindow: [0, 100],
    soc: 85,
    hitSocLimit: false,
    holdEnabled: true,
  });
  check(
    "hold on: a 100 W window at 85 % SOC (gate at 40 %) is a hold, not gated, and doesn't trip the hysteresis",
    hold.holdWatts === 100 && hold.chargingWatts === 0 && !hold.hitSocLimit && wattsForInverter(hold, true) === 100
  );
  check("…but the hold guard can still stop it", wattsForInverter(hold, false) === 0);
  const holdOff = decideScheduledBuy({
    ...gate,
    scheduledWattsPerWindow: [0, 100],
    soc: 85,
    hitSocLimit: false,
    holdEnabled: false,
  });
  check(
    "hold off: the same 100 W window is a charge, gated as on main, and trips the hysteresis",
    holdOff.holdWatts === 0 &&
      holdOff.chargingWatts === 0 &&
      holdOff.hitSocLimit &&
      wattsForInverter(holdOff, false) === 0
  );
  const charge = decideScheduledBuy({
    ...gate,
    scheduledWattsPerWindow: [15000],
    soc: 85,
    hitSocLimit: false,
    holdEnabled: true,
  });
  check(
    "a charging window at 85 % is gated as before, and trips the hysteresis",
    charge.chargingWatts === 0 && charge.holdWatts === 0 && charge.hitSocLimit && wattsForInverter(charge, true) === 0
  );
  const chargeOverHold = decideScheduledBuy({
    ...gate,
    scheduledWattsPerWindow: [15000, 100],
    soc: 30,
    hitSocLimit: false,
    holdEnabled: true,
  });
  check(
    "a charging window over a hold charges at its power (not a hold: the guard doesn't watch it)",
    chargeOverHold.chargingWatts === 15000 &&
      chargeOverHold.holdWatts === 0 &&
      wattsForInverter(chargeOverHold, false) === 15000
  );
  const gatedChargeOverHold = decideScheduledBuy({
    ...gate,
    scheduledWattsPerWindow: [15000, 100],
    soc: 85,
    hitSocLimit: false,
    holdEnabled: true,
  });
  check(
    "a gated charging window over a hold leaves the hold",
    gatedChargeOverHold.chargingWatts === 0 && gatedChargeOverHold.holdWatts === 100
  );
  const largestHold = decideScheduledBuy({
    ...gate,
    scheduledWattsPerWindow: [300],
    soc: 85,
    hitSocLimit: false,
    holdEnabled: true,
  });
  const smallestCharge = decideScheduledBuy({
    ...gate,
    scheduledWattsPerWindow: [301],
    soc: 85,
    hitSocLimit: false,
    holdEnabled: true,
  });
  check(
    "300 W is still a hold, 301 W a charging window",
    largestHold.holdWatts === 300 && smallestCharge.holdWatts === 0 && smallestCharge.hitSocLimit
  );
  const holdAfterTrip = decideScheduledBuy({
    ...gate,
    scheduledWattsPerWindow: [100],
    soc: 30,
    hitSocLimit: true,
    holdEnabled: true,
  });
  check(
    "hold on: a tripped gate doesn't stop a hold either",
    holdAfterTrip.holdWatts === 100 && holdAfterTrip.hitSocLimit
  );
}
{
  // Hold off is main: the SOC gate and its hysteresis walked through random schedules, every power from
  // negative to 15 kW, against a copy of main's powerFromSchedule (useShouldBuyPower.ts at ae01176)
  let seed = 7;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const powers = [0, 0, 0, -100, 50, 100, 200, 300, 301, 500, 1000, 3000, 15000];
  let mismatches = 0;
  let steps = 0;
  for (let sequence = 0; sequence < 200; sequence++) {
    const limits = {
      only_buy_below_soc: Math.round(random() * 100),
      start_buying_again_below_soc: Math.round(random() * 60),
    };
    let soc = random() * 100;
    let mainHitSocLimit = false;
    let branchHitSocLimit = false;
    for (let step = 0; step < 100; step++) {
      soc = Math.min(100, Math.max(0, soc + (random() - 0.5) * 10));
      const windows = Array.from(
        { length: Math.floor(random() * 4) },
        () => powers[Math.floor(random() * powers.length)]
      );
      const mainResult = mainPowerFromSchedule({ ...limits, values: windows, soc, hitSOCLimit: mainHitSocLimit });
      mainHitSocLimit = mainResult.hitSOCLimit;
      const decision = decideScheduledBuy({
        ...limits,
        scheduledWattsPerWindow: windows,
        soc,
        hitSocLimit: branchHitSocLimit,
        holdEnabled: false,
      });
      branchHitSocLimit = decision.hitSocLimit;
      const holdAllowedByGuard = random() < 0.5;
      steps++;
      if (
        wattsForInverter(decision, holdAllowedByGuard) !== mainResult.watts ||
        decision.hitSocLimit !== mainResult.hitSOCLimit ||
        decision.holdWatts !== 0
      ) {
        mismatches++;
      }
    }
  }
  check(
    "hold off: 20 000 random schedule steps (windows of every power, 300 W and under too) decide exactly as on main",
    mismatches === 0,
    `(${mismatches} of ${steps} differ)`
  );
}

console.log(failedChecks.length ? `\n${failedChecks.length} FAILURES: ${failedChecks.join(", ")}` : "\nAll passed");
process.exit(failedChecks.length ? 1 : 0);

/** main's (ae01176) powerFromSchedule, verbatim but for the closure: the reference hold off must match */
function mainPowerFromSchedule(input: {
  only_buy_below_soc: number;
  start_buying_again_below_soc: number;
  values: number[];
  soc: number;
  hitSOCLimit: boolean;
}): { watts: number; hitSOCLimit: boolean } {
  let hitSOCLimit = input.hitSOCLimit;
  const limitToUse = hitSOCLimit ? input.start_buying_again_below_soc : input.only_buy_below_soc;
  let result = Math.max(...input.values);
  if (Math.abs(result) === Infinity) {
    result = 0;
  }
  if (input.soc < limitToUse) {
    hitSOCLimit = false;
    return { watts: result, hitSOCLimit };
  } else if (result) {
    hitSOCLimit = true;
  }
  return { watts: 0, hitSOCLimit };
}
