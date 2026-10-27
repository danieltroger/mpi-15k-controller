/**
 * The buying setters against the real scheduler (schedulerCore.ts) and a modelled inverter, in
 * simulated time (buyingSetterSessionSimulation.ts): what actually goes on the wire at a window end —
 * when EDB0 goes out and at what current, that a cap or an EDB0 the inverter never applies is re-sent
 * a bounded number of times, never in a loop (the review of #63 measured 30 MUCHGC0100 sends in 30 min
 * and GS/PS polling paused 70 % of the time with an unbounded re-queue), and #65's slow commits.
 * The simulation runs the production scheduler timing: polling continues through every write, its
 * confirm reads it back from 9 s after it, every 4 s.
 * Run from backend/ with:  yarn node src/buying/buyingSetterSession.selftest.ts
 */
import process from "process";
import { setOnErrorLog } from "../utilities/logging.ts";
import { STEP_DOWN_EXTENSION_MS, STEP_DOWN_TIMEOUT_MS } from "./buyWindowEndStepDown.ts";
import {
  ALTERNATE_CAP_AMPS,
  HALL_ALLOWANCE_ABOVE_IDLE_LIMIT_AMPS,
  IDLE_AC_CHARGING_LIMIT_AMPS,
} from "./buyWindowEndEvidence.ts";
import { EDB0_RETRY_SPACING_MS, MAX_EDB0_RETRIES } from "./buyWindowEndRelease.ts";
import { READBACK_REQUEST_INTERVAL_MS } from "./buyWindowEndAsks.ts";
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
  // No cap the inverter will apply (the review's requeueLoop.ts, MUCHGC0090 ignored too): bounded re-sends;
  // the hall at 261 A at the timeout extends the hold (paging), then EDB0 goes out regardless (paging again)
  const reportedErrors: string[] = [];
  setOnErrorLog(args => reportedErrors.push(args.join(" ")));
  const simulation = createSessionSimulation({
    chargingAmperageForBuying: 261,
    inverter: { ...nightWindowInverter, neverApplies: new Set(["MUCHGC0100", "MUCHGC0090"]) },
  });
  runUntil(simulation, 0);
  simulation.lineTimeOnWritesMs = 0;
  simulation.harness.setChargingAmperage(0);
  runUntil(simulation, THIRTY_MINUTES_MS);
  const extendedDeadlineMs = STEP_DOWN_TIMEOUT_MS + STEP_DOWN_EXTENSION_MS;
  const capSends = [...sentCommands(simulation, "MUCHGC0100", 0), ...sentCommands(simulation, "MUCHGC0090", 0)];
  const edb0Sends = sentCommands(simulation, "EDB0", 0);
  check(
    "never-applied cap: MUCHGC0100 twice + MUCHGC0090 once, all inside the extended hold, then never again",
    capSends.length === 3 &&
      sentCommands(simulation, "MUCHGC0090", 0).length === 1 &&
      capSends.every(sent => sent.atMs <= extendedDeadlineMs),
    describe(capSends)
  );
  check(
    "…EDB0 once, at the extended deadline (~180 s)",
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
  // The unbounded re-queue's 30 MUCHGC0100 sends would cost ~30 × (0.3 s + ~12 confirm reads × 0.5 s) ≈ 10 %
  const writeShare = simulation.lineTimeOnWritesMs / THIRTY_MINUTES_MS;
  check(
    "…writes and their confirm reads took < 3 % of the line in the 30 min, GS/PS polling the rest",
    writeShare < 0.03,
    `${(writeShare * 100).toFixed(1)} %`
  );
  simulation.harness.dispose();
}

{
  // The inverter ignores MUCHGC0100 but applies another cap value: the extension's MUCHGC0090 ends the
  // full-current hold on the step-down's own proof, without a full-current EDB0
  const reportedErrors: string[] = [];
  setOnErrorLog(args => reportedErrors.push(args.join(" ")));
  const simulation = createSessionSimulation({
    chargingAmperageForBuying: 261,
    inverter: { ...nightWindowInverter, neverApplies: new Set(["MUCHGC0100"]) },
  });
  runUntil(simulation, 0);
  simulation.harness.setChargingAmperage(0);
  runUntil(simulation, THIRTY_MINUTES_MS);
  const alternateCapSends = sentCommands(simulation, "MUCHGC0090", 0);
  const edb0Sends = sentCommands(simulation, "EDB0", 0);
  check(
    "alternate cap applies: MUCHGC0090 at the timeout, EDB0 once ~15 s later at 9 A — paged once, no full-current stop",
    alternateCapSends.length === 1 &&
      alternateCapSends[0]!.atMs >= STEP_DOWN_TIMEOUT_MS &&
      edb0Sends.length === 1 &&
      edb0Sends[0]!.atMs < STEP_DOWN_TIMEOUT_MS + STEP_DOWN_EXTENSION_MS &&
      edb0Sends[0]!.limitAmpsAtSend === ALTERNATE_CAP_AMPS &&
      edb0Sends[0]!.hallAmpsAtSend <= ALLOWED_NIGHT_HALL_AMPS &&
      reportedErrors.filter(text => text.includes("one-step stop at full current")).length === 0,
    describe([...alternateCapSends, ...edb0Sends])
  );
  setOnErrorLog(undefined);
  simulation.harness.dispose();
}

{
  // A firmware that NAKs limits below 10 A: the NAK of MUCHGC0090 re-asserts MUCHGC0100 inside the
  // extension (its 60 s gate long open), still bounded — here 0100 never applies either, so EDB0 follows
  // at the extended deadline
  const simulation = createSessionSimulation({
    chargingAmperageForBuying: 261,
    inverter: { ...nightWindowInverter, neverApplies: new Set(["MUCHGC0100"]), rejects: new Set(["MUCHGC0090"]) },
  });
  runUntil(simulation, 0);
  simulation.harness.setChargingAmperage(0);
  runUntil(simulation, THIRTY_MINUTES_MS);
  const extendedDeadlineMs = STEP_DOWN_TIMEOUT_MS + STEP_DOWN_EXTENSION_MS;
  const rejectedAt = sentCommands(simulation, "MUCHGC0090", 0)[0]?.atMs ?? Infinity;
  const fallbackSends = sentCommands(simulation, "MUCHGC0100", 0).filter(sent => sent.atMs > rejectedAt);
  const edb0Sends = sentCommands(simulation, "EDB0", 0);
  check(
    "MUCHGC0090 NAKed: MUCHGC0100 re-sent once inside the extension, then EDB0 at the deadline — nothing more",
    fallbackSends.length === 1 &&
      fallbackSends[0]!.atMs < extendedDeadlineMs &&
      sentCommands(simulation, "MUCHGC0100", 0).length === 3 &&
      edb0Sends.length === 1 &&
      edb0Sends[0]!.atMs >= extendedDeadlineMs,
    describe([...sentCommands(simulation, "MUCHGC0090", 0), ...sentCommands(simulation, "MUCHGC0100", 0), ...edb0Sends])
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
  // 10 A after 10 → 261 → 10 can't tell whether MUCHGC2610 is still to land; the confirm's re-reads (or
  // the alternate cap) settle it — either way EDB0 waits for a cap in effect
  check(
    "window ending 11 s in at full current, HECS still 'disabled': EDB0 only once the (alternate) cap is in effect",
    fullCurrentBeforeEnd &&
      hecsStillStale &&
      edb0Sends.length === 1 &&
      edb0Sends[0]!.hallAmpsAtSend <= ALLOWED_NIGHT_HALL_AMPS &&
      edb0Sends[0]!.limitAmpsAtSend <= IDLE_AC_CHARGING_LIMIT_AMPS,
    `full current at the end: ${fullCurrentBeforeEnd}, HECS stale: ${hecsStillStale}; ` +
      describe([...sentCommands(simulation, "EDB1", 0), ...sentCommands(simulation, "MUCHGC2610", 0), ...edb0Sends])
  );
  simulation.harness.dispose();
}

{
  // Extend-and-re-end within seconds (polling continues, a check is judged from its write + 9 s and
  // re-read every 4 s), where a readback can predate MUCHGC2610's commit
  const simulation = createSessionSimulation({ chargingAmperageForBuying: 261, inverter: nightWindowInverter });
  runUntil(simulation, 0);
  simulation.harness.setChargingAmperage(0);
  runUntil(simulation, 5_500);
  simulation.harness.setChargingAmperage(261);
  runUntil(simulation, 8_000);
  simulation.harness.setChargingAmperage(0);
  runUntil(simulation, THIRTY_MINUTES_MS);
  const edb0Sends = sentCommands(simulation, "EDB0", 0);
  check(
    "extended and re-ended: EDB0 only with the cap in effect, not while MUCHGC2610 is",
    edb0Sends.length === 1 &&
      edb0Sends[0]!.limitAmpsAtSend === IDLE_AC_CHARGING_LIMIT_AMPS &&
      edb0Sends[0]!.hallAmpsAtSend <= ALLOWED_NIGHT_HALL_AMPS,
    describe(edb0Sends)
  );
  simulation.harness.dispose();
}

{
  // #65: commits take 45 s; the window ends, is re-entered at 5 s and ends again at 8 s. Under #63's fixed
  // 12 s margin a 47 s re-check's 10 A released EDB0 as MUCHGC2610 landed (180 of 180 sweep runs at full
  // current). Now nothing proves the cap until the gated MUCHGC0100 has landed — after its own confirms
  // gave up — and a settings readback (its own re-checks', or one the step-down asks for) shows it.
  const reportedErrors: string[] = [];
  setOnErrorLog(args => reportedErrors.push(args.join(" ")));
  const simulation = createSessionSimulation({
    chargingAmperageForBuying: 261,
    inverter: { ...nightWindowInverter, commitAfterWriteMs: 45_000 },
  });
  runUntil(simulation, 0);
  simulation.harness.setChargingAmperage(0);
  runUntil(simulation, 5_000);
  simulation.harness.setChargingAmperage(261);
  runUntil(simulation, 8_000);
  simulation.harness.setChargingAmperage(0);
  runUntil(simulation, THIRTY_MINUTES_MS);
  const edb0Sends = sentCommands(simulation, "EDB0", 0);
  // The step-down asks for a readback once the hall settles; bound the asks (at least one, never closer
  // than the request interval) rather than pin their count, which depends on where the re-checks fall
  const requestTimes = simulation.harness.readbackRequestsAtMs;
  const requestsBounded =
    requestTimes.length >= 1 &&
    requestTimes.every(
      (requestedAtMs, index) => index === 0 || requestedAtMs - requestTimes[index - 1]! >= READBACK_REQUEST_INTERVAL_MS
    );
  check(
    "45 s commits, extended and re-ended: EDB0 once, with the cap in effect, inside the timeout, nothing paged",
    edb0Sends.length === 1 &&
      edb0Sends[0]!.limitAmpsAtSend === IDLE_AC_CHARGING_LIMIT_AMPS &&
      edb0Sends[0]!.hallAmpsAtSend <= ALLOWED_NIGHT_HALL_AMPS &&
      edb0Sends[0]!.atMs < 8_000 + STEP_DOWN_TIMEOUT_MS &&
      requestsBounded &&
      reportedErrors.length === 0,
    `${describe(edb0Sends)}; readback requests at ${simulation.harness.readbackRequestsAtMs.join()}; ${reportedErrors.join(" | ").slice(0, 200)}`
  );
  check(
    "…and the inverter ends with AC charging off at the 10 A cap",
    !simulation.inverter.acChargingEnabled && simulation.inverter.limitAmps === IDLE_AC_CHARGING_LIMIT_AMPS
  );
  setOnErrorLog(undefined);
  simulation.harness.dispose();
}

let alternateCapNakedRuns = 0;
for (const commitAfterWriteMs of [6_000, 12_000]) {
  // #70's review: a firmware that NAKs MUCHGC0090. Extended and re-ended, the ambiguity's alternate cap
  // is NAKed, its fallback MUCHGC0100 waits on the 60 s gate, and a NAKed write gets no confirm —
  // deferring to it blocked every readback request, 119 of 180 sweep runs timed out blind
  const simulation = createSessionSimulation({
    chargingAmperageForBuying: 261,
    inverter: { ...nightWindowInverter, commitAfterWriteMs, rejects: new Set(["MUCHGC0090"]) },
  });
  runUntil(simulation, 0);
  simulation.harness.setChargingAmperage(0);
  runUntil(simulation, 5_000);
  simulation.harness.setChargingAmperage(261);
  runUntil(simulation, 8_000);
  simulation.harness.setChargingAmperage(0);
  runUntil(simulation, THIRTY_MINUTES_MS);
  const edb0Sends = sentCommands(simulation, "EDB0", 0);
  // Whether the alternate cap goes out depends on where the re-checks fall (the 12 s run proves the cap
  // without it); the check below makes sure at least one run takes the NAK path
  const alternateCapSends = sentCommands(simulation, "MUCHGC0090", 0).length;
  if (alternateCapSends) alternateCapNakedRuns++;
  check(
    `MUCHGC0090 NAKed, ${commitAfterWriteMs / 1000} s commits, extended and re-ended: EDB0 once, cap in effect, before the timeout`,
    alternateCapSends <= 1 &&
      edb0Sends.length === 1 &&
      edb0Sends[0]!.limitAmpsAtSend === IDLE_AC_CHARGING_LIMIT_AMPS &&
      edb0Sends[0]!.hallAmpsAtSend <= ALLOWED_NIGHT_HALL_AMPS &&
      edb0Sends[0]!.atMs < 8_000 + STEP_DOWN_TIMEOUT_MS,
    `${describe([...sentCommands(simulation, "MUCHGC0090", 0), ...edb0Sends])}; readback requests at ${simulation.harness.readbackRequestsAtMs.join()}`
  );
  simulation.harness.dispose();
}
check("…and the NAKed alternate cap was exercised (sent, and NAKed, in at least one run)", alternateCapNakedRuns >= 1);

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
