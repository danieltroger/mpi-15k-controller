/**
 * The buying setters against #48's real scheduler (schedulerCore.ts) and a modelled inverter, in
 * simulated time (buyingSetterSessionSimulation.ts): what actually goes on the wire at a window end —
 * when EDB0 goes out and at what current, and that a cap or an EDB0 the inverter never applies is
 * re-sent a bounded number of times, never in a loop (the review of #63 measured 30 MUCHGC0100 sends
 * in 30 min and GS/PS polling paused 70 % of the time with an unbounded re-queue).
 * Run from backend/ with:  yarn node src/buying/buyingSetterSession.selftest.ts
 */
import process from "process";
import { setOnErrorLog } from "../utilities/logging.ts";
import {
  HALL_ALLOWANCE_ABOVE_IDLE_LIMIT_AMPS,
  IDLE_AC_CHARGING_LIMIT_AMPS,
  STEP_DOWN_EXTENSION_MS,
  STEP_DOWN_TIMEOUT_MS,
} from "./buyWindowEndStepDown.ts";
import { EDB0_RETRY_SPACING_MS, MAX_EDB0_RETRIES } from "./buyWindowEndRelease.ts";
import { createSessionSimulation, runUntil, type SentSetter, sentCommands } from "./buyingSetterSessionSimulation.ts";

const failedChecks: string[] = [];
const THIRTY_MINUTES_MS = 30 * 60_000;
const ALLOWED_NIGHT_HALL_AMPS = IDLE_AC_CHARGING_LIMIT_AMPS + HALL_ALLOWANCE_ABOVE_IDLE_LIMIT_AMPS;
const nightWindowInverter = { limitAmps: 261, acChargingEnabled: true, neverApplies: new Set<string>() };

{
  // The incident's window end, every write applying normally
  const simulation = createSessionSimulation({ chargingAmperageForBuying: 261, inverter: nightWindowInverter });
  runUntil(simulation, 0);
  simulation.harness.setChargingAmperage(0);
  runUntil(simulation, THIRTY_MINUTES_MS);
  const capSends = sentCommands(simulation, "MUCHGC0100", 0);
  const edb0Sends = sentCommands(simulation, "EDB0", 0);
  check("normal end: MUCHGC0100 sent once", capSends.length === 1, describe(capSends));
  check(
    "…EDB0 sent once, after the cap's confirm, with the cap in effect and the hall at ~10 A",
    edb0Sends.length === 1 &&
      edb0Sends[0]!.atMs >= 12_000 &&
      edb0Sends[0]!.limitAmpsAtSend === IDLE_AC_CHARGING_LIMIT_AMPS &&
      edb0Sends[0]!.hallAmpsAtSend <= ALLOWED_NIGHT_HALL_AMPS,
    describe(edb0Sends)
  );
  check(
    "…and the inverter ends with AC charging off at the 10 A cap",
    !simulation.inverter.acChargingEnabled && simulation.inverter.limitAmps === IDLE_AC_CHARGING_LIMIT_AMPS
  );
  simulation.harness.dispose();
}

{
  // The cap is ACKed but never applied (the review's requeueLoop.ts): bounded re-sends; the hall at 261 A
  // at the timeout extends the hold once (paging), then EDB0 goes out regardless (paging again)
  const reportedErrors: string[] = [];
  setOnErrorLog(args => reportedErrors.push(args.join(" ")));
  const simulation = createSessionSimulation({
    chargingAmperageForBuying: 261,
    inverter: { ...nightWindowInverter, neverApplies: new Set(["MUCHGC0100"]) },
  });
  runUntil(simulation, 0);
  simulation.pollingPausedMs = 0;
  simulation.harness.setChargingAmperage(0);
  runUntil(simulation, THIRTY_MINUTES_MS);
  const extendedDeadlineMs = STEP_DOWN_TIMEOUT_MS + STEP_DOWN_EXTENSION_MS;
  const capSends = sentCommands(simulation, "MUCHGC0100", 0);
  const edb0Sends = sentCommands(simulation, "EDB0", 0);
  check(
    "never-applied cap: MUCHGC0100 out at most 3 times, all inside the extended hold, then never again",
    capSends.length <= 3 && capSends.every(sent => sent.atMs <= extendedDeadlineMs),
    describe(capSends)
  );
  check(
    "…EDB0 once, at the extended deadline (~300 s)",
    edb0Sends.length === 1 &&
      edb0Sends[0]!.atMs >= extendedDeadlineMs &&
      edb0Sends[0]!.atMs <= extendedDeadlineMs + 3_000,
    describe(edb0Sends)
  );
  check(
    "…paging twice: when the hold is extended and when EDB0 goes out at full current",
    reportedErrors.filter(text => text.includes("the 10 A cap is not in effect")).length === 1 &&
      reportedErrors.filter(text => text.includes("one-step stop at full current")).length === 1,
    reportedErrors.join(" | ").slice(0, 300)
  );
  setOnErrorLog(undefined);
  const pausedShare = simulation.pollingPausedMs / THIRTY_MINUTES_MS;
  check(
    "…GS/PS polling paused < 10 % of the 30 min (the unbounded re-queue: 70 %)",
    pausedShare < 0.1,
    `${(pausedShare * 100).toFixed(1)} %`
  );
  simulation.harness.dispose();
}

{
  // In a window, a target the inverter never applies is not re-sent by the buying module (as on main)
  const simulation = createSessionSimulation({
    chargingAmperageForBuying: 261,
    inverter: { limitAmps: 10, acChargingEnabled: true, neverApplies: new Set(["MUCHGC2610"]) },
  });
  runUntil(simulation, THIRTY_MINUTES_MS);
  const windowTargetSends = sentCommands(simulation, "MUCHGC2610");
  check(
    "in-window never-applied MUCHGC2610: sent once in 40 min",
    windowTargetSends.length === 1,
    describe(windowTargetSends)
  );
  simulation.harness.dispose();
}

{
  // EDB0 ACKed but never applied: bounded retries, then one errorLog
  const reportedErrors: string[] = [];
  setOnErrorLog(args => reportedErrors.push(args.join(" ")));
  const simulation = createSessionSimulation({
    chargingAmperageForBuying: 261,
    inverter: { ...nightWindowInverter, neverApplies: new Set(["EDB0"]) },
  });
  runUntil(simulation, 0);
  simulation.harness.setChargingAmperage(0);
  runUntil(simulation, THIRTY_MINUTES_MS);
  const edb0Sends = sentCommands(simulation, "EDB0", 0);
  const gapsMs = edb0Sends.slice(1).map((sent, index) => sent.atMs - edb0Sends[index]!.atMs);
  check(
    `never-applied EDB0: sent 1 + ${MAX_EDB0_RETRIES} times, ≥ ${EDB0_RETRY_SPACING_MS / 1000} s apart`,
    edb0Sends.length === 1 + MAX_EDB0_RETRIES && gapsMs.every(gapMs => gapMs >= EDB0_RETRY_SPACING_MS),
    describe(edb0Sends)
  );
  check(
    "…then exactly one errorLog saying AC charging stays on, at the last read-back limit",
    reportedErrors.filter(text => text.includes("EDB0 still not applied")).length === 1,
    reportedErrors.join(" | ")
  );
  setOnErrorLog(undefined);
  simulation.harness.dispose();
}

{
  // The review's case B on the wire: a window ending 11 s after it started, its EDB1 + MUCHGC2610 already
  // committed (full current) while HECS still shows the pre-window "disabled" (their confirm is still due)
  const simulation = createSessionSimulation({
    chargingAmperageForBuying: 0,
    inverter: { limitAmps: 10, acChargingEnabled: false, neverApplies: new Set() },
  });
  runUntil(simulation, 0);
  simulation.harness.setChargingAmperage(261);
  runUntil(simulation, 11_000);
  const fullCurrentBeforeEnd = simulation.inverter.acChargingEnabled && simulation.inverter.limitAmps === 261;
  const hecsStillStale = simulation.harness.wiring.currentlyBuying() === false;
  simulation.harness.setChargingAmperage(0);
  runUntil(simulation, THIRTY_MINUTES_MS);
  const edb0Sends = sentCommands(simulation, "EDB0", 0);
  check(
    "window ending 11 s in at full current, HECS still 'disabled': EDB0 only once the cap is in effect",
    fullCurrentBeforeEnd &&
      hecsStillStale &&
      edb0Sends.length === 1 &&
      edb0Sends[0]!.limitAmpsAtSend === IDLE_AC_CHARGING_LIMIT_AMPS &&
      edb0Sends[0]!.hallAmpsAtSend <= ALLOWED_NIGHT_HALL_AMPS,
    `full current at the end: ${fullCurrentBeforeEnd}, HECS stale: ${hecsStillStale}; ` +
      describe([...sentCommands(simulation, "EDB1", 0), ...sentCommands(simulation, "MUCHGC2610", 0), ...edb0Sends])
  );
  simulation.harness.dispose();
}

{
  // Extend-and-re-end within seconds with a gap-0-like confirm cadence (#62: confirms soon after a write
  // and re-checks every few seconds), where a readback can predate MUCHGC2610's commit
  const simulation = createSessionSimulation({
    chargingAmperageForBuying: 261,
    inverter: nightWindowInverter,
    timingOverrides: { quietGapAfterWriteMs: 4_000, confirmBackoffMs: 4_000 },
  });
  runUntil(simulation, 0);
  simulation.harness.setChargingAmperage(0);
  runUntil(simulation, 5_500);
  simulation.harness.setChargingAmperage(261);
  runUntil(simulation, 8_000);
  simulation.harness.setChargingAmperage(0);
  runUntil(simulation, THIRTY_MINUTES_MS);
  const edb0Sends = sentCommands(simulation, "EDB0", 0);
  check(
    "gap-0-like cadence, extended and re-ended: EDB0 only with the cap in effect, not while MUCHGC2610 is",
    edb0Sends.length === 1 &&
      edb0Sends[0]!.limitAmpsAtSend === IDLE_AC_CHARGING_LIMIT_AMPS &&
      edb0Sends[0]!.hallAmpsAtSend <= ALLOWED_NIGHT_HALL_AMPS,
    describe(edb0Sends)
  );
  simulation.harness.dispose();
}

if (failedChecks.length) {
  console.error(`\n${failedChecks.length} check(s) FAILED:`, failedChecks.join("; "));
  process.exit(1);
}
console.log("\nAll buying setter session checks passed");

function check(name: string, condition: boolean, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}: ${name} ${detail}`);
  if (!condition) failedChecks.push(name);
}

function describe(sends: SentSetter[]): string {
  return sends
    .map(
      sent =>
        `${sent.command}@${(sent.atMs / 1000).toFixed(1)}s(limit ${sent.limitAmpsAtSend} A, hall ${sent.hallAmpsAtSend} A)`
    )
    .join(" ");
}
