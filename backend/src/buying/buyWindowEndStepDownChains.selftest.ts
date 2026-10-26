/**
 * Pure self-test of the buy-window end step-down's proof from #62's write chains (#65): what the chain
 * lets a readback prove, the slow-commit extend-and-re-end that the old fixed 12 s margin released at full
 * current, why the step-down is handed the drop-trust chain and not the confirm's, when it asks the
 * session for a fresh settings readback, and an unproven EDB1 holding off a cancel until its 90 s window. Main paths: buyWindowEndStepDown.selftest.ts.
 * Run from backend/ with:  yarn node src/buying/buyWindowEndStepDownChains.selftest.ts
 */
import process from "process";
import { unprovenWritesIn } from "../inverterComms/fieldWriteChains.ts";
import { BATS_AC_CHARGING_LIMIT_FIELD } from "./acChargingReadbacks.ts";
import { READBACK_REQUEST_INTERVAL_MS } from "./buyWindowEndAsks.ts";
import { ambiguousHigherLimitsAmps, enableMayLand, limitEvidenceOf, SETTLED_FOR_MS } from "./buyWindowEndEvidence.ts";
import { holdsAcChargingOn, settingsReadbackRequests } from "./buyWindowEndStepDown.ts";
import {
  batsAt,
  buyingFor,
  endWindow,
  hecsAt,
  holdsAtEveryStep,
  lastEvent,
  nightBuying,
  sentAt,
  type Simulation,
  stepAt,
  windowEnd,
} from "./buyWindowEndStepDownSimulation.ts";

const failedChecks: string[] = [];
const readback = (amps: number, observedAtMs: number) => ({ amps, observedAtMs });
const write = (value: number | string, sentAtMs: number) => ({ value, sentAtMs });

check(
  "evidence: no readback / a higher limit / a cap with a higher write unproven / a proven cap",
  limitEvidenceOf(undefined, []) === "none" &&
    limitEvidenceOf(readback(12, 5), []) === "shows_higher_limit" &&
    limitEvidenceOf(readback(10, 70), [write(261, 5)]) === "higher_limit_unproven" &&
    limitEvidenceOf(readback(10, 70), [write(10, 60), write(9, 65)]) === "shows_cap" &&
    limitEvidenceOf(readback(10, 70), []) === "shows_cap"
);
check(
  "evidence: an unproven value that isn't amps can't vouch for a cap",
  limitEvidenceOf(readback(10, 70), [write("garbled", 5)]) === "higher_limit_unproven"
);
check(
  "A→B→A: 10 A read after 261 → 10 can't rule out the 261 A write; 10 A read before the second cap can",
  ambiguousHigherLimitsAmps(readback(10, 70), [write(261, 5), write(10, 60)]).join() === "261" &&
    ambiguousHigherLimitsAmps(readback(10, 59), [write(261, 5), write(10, 60)]).length === 0
);
check(
  "…a higher write merely pending (no later write of the read value), a higher readback or one showing the alternate cap aren't ambiguous",
  ambiguousHigherLimitsAmps(readback(10, 70), [write(261, 5)]).length === 0 &&
    ambiguousHigherLimitsAmps(readback(261, 70), [write(10, 5), write(261, 6)]).length === 0 &&
    ambiguousHigherLimitsAmps(readback(9, 70), [write(261, 5), write(9, 60)]).length === 0
);
check(
  "EDB1 may still land only while it is the flag's last unproven write",
  !enableMayLand([]) &&
    enableMayLand([write("enabled", 5)]) &&
    !enableMayLand([write("enabled", 5), write("disabled", 20)]) &&
    enableMayLand([write("disabled", 5), write("enabled", 20)])
);

{
  // The issue's case (#63's narrow review): commits take 45 s, quiet gap 12 s. The window ends at 0
  // (MUCHGC0100 at 0.3 s, lands 45.3 s), is re-entered at 5 s (MUCHGC2610 at 5.3 s, lands 50.3 s) and ends
  // again at 8 s (that MUCHGC0100 is gated until 61 s, lands 106 s). The backoff re-check at 47.3 s reads
  // 10 A: the 12 s margin took it as proof and released at 50.3 s — as MUCHGC2610 landed, at full current.
  const simulation = slowCommitExtendAndReEnd();
  stepAt(simulation, 47_300, { hallBatteryAmps: 10, ...batsAt(simulation, 10, 47_300) });
  const heldWhileHigherUnproven = holdsAtEveryStep(simulation, 47_550, 50_250, () => ({}));
  check(
    "45 s commits: the 47.3 s readback of 10 A doesn't prove the cap while MUCHGC2610 is unproven → held, hall low",
    heldWhileHigherUnproven &&
      lastEvent(simulation, "limit_confirmed") === undefined &&
      simulation.inputs.unprovenLimitWrites.map(unproven => unproven.value).join() === "261"
  );
  // MUCHGC2610 lands; the gated cap goes out at 61 s and its confirm and backoff re-check (73.5 s, 104 s)
  // both read 261 A before it lands at 106 s. Nothing would read BATS again before the 128 s deadline.
  stepAt(simulation, 50_300, { hallBatteryAmps: 280 });
  stepAt(simulation, 61_000, sentAt(simulation, "MUCHGC0100", 61_000));
  stepAt(simulation, 73_500, batsAt(simulation, 261, 73_500));
  stepAt(simulation, 104_000, batsAt(simulation, 261, 104_000));
  stepAt(simulation, 106_000, { hallBatteryAmps: 10 });
  const heldUntilRequest = holdsAtEveryStep(simulation, 106_250, 108_750, () => ({}));
  check(
    "…the cap lands after its confirms gave up: no request while the hall settles",
    heldUntilRequest && settingsReadbackRequests(simulation.state) === 0
  );
  stepAt(simulation, 106_000 + SETTLED_FOR_MS, {});
  check(
    "…3 s on, the 104 s readback predates what the hall shows: a settings readback is asked for at once",
    settingsReadbackRequests(simulation.state) === 1 &&
      lastEvent(simulation, "readback_requested")?.limitEvidence === "shows_higher_limit"
  );
  stepAt(simulation, 110_300, batsAt(simulation, 10, 110_300));
  check(
    "…the requested readback proves the cap: released 102.3 s after the re-end, no timeout",
    lastEvent(simulation, "released")?.afterMs === 102_300 && lastEvent(simulation, "timed_out") === undefined,
    JSON.stringify(lastEvent(simulation, "released"))
  );
}

{
  // Why the drop-trust chain (90 s) and not the confirm's (30 s): at the 47.3 s readback the confirm's
  // window takes both MUCHGC0100 (0.3 s) and MUCHGC2610 (5.3 s) as landed, so "10 A" proves the cap in it —
  // a step-down handed that chain releases at 50.3 s, the instant MUCHGC2610 lands at full current
  const simulation = slowCommitExtendAndReEnd();
  batsAt(simulation, 10, 47_300);
  const confirmChainWrites = unprovenWritesIn(
    simulation.scheduler.fieldWriteChains,
    "BATS",
    BATS_AC_CHARGING_LIMIT_FIELD
  );
  stepAt(simulation, 47_300, {
    hallBatteryAmps: 10,
    limitReadback: { amps: 10, observedAtMs: 47_300 },
    unprovenLimitWrites: confirmChainWrites,
  });
  holdsAtEveryStep(simulation, 47_550, 50_250, () => ({}));
  stepAt(simulation, 50_300, {});
  check(
    "the confirm's 30 s chain holds nothing unproven at 47.3 s → the step-down would release at 50.3 s, the F14 setup",
    confirmChainWrites.length === 0 &&
      !holdsAcChargingOn(simulation.state) &&
      lastEvent(simulation, "released")?.afterMs === 42_300
  );
}

{
  // One request at a time, none while a write's own confirm is due, none while the hall says the cap isn't
  // in effect. A pack that takes 4 A whatever the limit, with a cap the inverter never applies:
  const simulation = buyingFor({ ...nightBuying, hallBatteryAmps: 4 });
  endWindow(simulation);
  holdsAtEveryStep(simulation, 750, 12_250, () => ({}));
  check(
    "no request before the cap's own confirm has read BATS (the hall low from the start)",
    settingsReadbackRequests(simulation.state) === 0
  );
  stepAt(simulation, 12_500, batsAt(simulation, 261, 12_500));
  holdsAtEveryStep(simulation, 12_750, 12_500 + READBACK_REQUEST_INTERVAL_MS - 250, () => ({}));
  const beforeInterval = settingsReadbackRequests(simulation.state);
  stepAt(simulation, 12_500 + READBACK_REQUEST_INTERVAL_MS, {});
  check(
    "…the confirm read 261 A after the hall settled: a request once that readback is 10 s old",
    beforeInterval === 0 && settingsReadbackRequests(simulation.state) === 1
  );
  // The silent backoff holds the session off until 42.5 s: the request stays open, nothing more is asked
  holdsAtEveryStep(simulation, 22_750, 42_250, () => ({}));
  const whileOpen = settingsReadbackRequests(simulation.state);
  stepAt(simulation, 42_500, batsAt(simulation, 261, 42_500));
  holdsAtEveryStep(simulation, 42_750, 52_250, () => ({}));
  const afterAnswer = settingsReadbackRequests(simulation.state);
  stepAt(simulation, 52_500, {});
  check(
    "…open until a readback answers it; asked again 10 s after that answer still shows 261 A",
    whileOpen === 1 && afterAnswer === 1 && settingsReadbackRequests(simulation.state) === 2
  );

  const fullCurrent = buyingFor(nightBuying);
  endWindow(fullCurrent);
  stepAt(fullCurrent, 12_500, batsAt(fullCurrent, 261, 12_500));
  holdsAtEveryStep(fullCurrent, 12_750, 100_000, () => ({}));
  check(
    "the hall at 280 A (the cap demonstrably not in effect) → no readback requests at all",
    settingsReadbackRequests(fullCurrent.state) === 0 && lastEvent(fullCurrent, "readback_requested") === undefined
  );
}

{
  // Someone else disables AC charging (the inverter's LCD) mid-step-down: EDB1 was read back long ago, so
  // nothing can switch it on again
  const simulation = buyingFor(nightBuying);
  endWindow(simulation);
  stepAt(simulation, 8_000, hecsAt(simulation, "disabled", 8_000));
  check(
    "AC charging off by other means → cancelled, nothing held",
    lastEvent(simulation, "cancelled")?.reason === "AC charging already disabled" &&
      !holdsAcChargingOn(simulation.state)
  );
  // …but an EDB1 no readback has proven landed (the window was re-entered 3 s before it ended) may still
  // switch it on: a "disabled" can't cancel until EDB1 is past the chain's 90 s trust window
  const recentEnable = buyingFor(nightBuying);
  stepAt(recentEnable, -3_000, sentAt(recentEnable, "EDB1", -3_000));
  endWindow(recentEnable);
  stepAt(recentEnable, 8_000, hecsAt(recentEnable, "disabled", 8_000));
  stepAt(recentEnable, 86_500, hecsAt(recentEnable, "disabled", 86_500));
  check(
    "HECS 'disabled' while EDB1 is unproven (11 s and 89.5 s after it) → still held",
    holdsAcChargingOn(recentEnable.state)
  );
  stepAt(recentEnable, 87_000, hecsAt(recentEnable, "disabled", 87_000));
  check("…a 'disabled' 90 s after it → cancelled", !holdsAcChargingOn(recentEnable.state));
}

if (failedChecks.length) {
  console.error(`\n${failedChecks.length} check(s) FAILED:`, failedChecks.join("; "));
  process.exit(1);
}
console.log("\nAll buy-window end step-down write-chain checks passed");

function check(name: string, condition: boolean, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}: ${name} ${detail}`);
  if (!condition) failedChecks.push(name);
}

/** The issue's slow-commit timeline up to just before the 47.3 s backoff re-check (step-down from 8 s) */
function slowCommitExtendAndReEnd(): Simulation {
  const simulation = buyingFor(nightBuying);
  stepAt(simulation, 0, windowEnd);
  stepAt(simulation, 300, sentAt(simulation, "MUCHGC0100", 300));
  stepAt(simulation, 5_000, { gridChargingWanted: true });
  stepAt(simulation, 5_300, sentAt(simulation, "MUCHGC2610", 5_300));
  stepAt(simulation, 8_000, windowEnd);
  stepAt(simulation, 17_300, batsAt(simulation, 261, 17_300));
  holdsAtEveryStep(simulation, 17_550, 47_050, () => ({}));
  return simulation;
}
