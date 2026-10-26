/**
 * Pure self-test of the buy-window end step-down's released phase (buyWindowEndRelease.ts): which HECS
 * readbacks may end it, a new window superseding it, and the bounded EDB0 retries when EDB0 is ACKed
 * but never applied.
 * Run from backend/ with:  yarn node src/buying/buyWindowEndRelease.selftest.ts
 */
import process from "process";
import { holdsAcChargingOn, type StepDownEvent } from "./buyWindowEndStepDown.ts";
import {
  EDB0_RETRY_SPACING_MS,
  edb0RetryRequests,
  MAX_EDB0_RETRIES,
  releasedAt,
  whileReleased,
} from "./buyWindowEndRelease.ts";
import {
  batsAt,
  buyingFor,
  CONFIRM_AFTER_WRITE_MS,
  endWindow,
  hecs,
  hecsAt,
  lastEvent,
  nightBuying,
  sentAt,
  stepAt,
} from "./buyWindowEndStepDownSimulation.ts";

const failedChecks: string[] = [];

{
  // The phase on its own: released at 20 s of a step-down that started at 0
  const released = releasedAt(0, 20_000);
  const quiet = { gridChargingWanted: false, limitReadback: undefined };
  const events: StepDownEvent[] = [];
  check(
    "a HECS 'disabled' from before the release can't end it (it may be the stale pre-window one)",
    whileReleased(released, { ...quiet, acChargingReadback: hecs("disabled", 19_000) }, 21_000, events) === released &&
      events.length === 0
  );
  check(
    "…one newer than the release does, back to idle",
    whileReleased(released, { ...quiet, acChargingReadback: hecs("disabled", 20_500) }, 21_000, events).phase ===
      "idle" && events.at(-1)?.kind === "ac_charging_disabled_confirmed"
  );
  check(
    "a new window wanting grid charging supersedes the release",
    whileReleased(released, { ...quiet, gridChargingWanted: true, acChargingReadback: undefined }, 21_000, events)
      .phase === "idle" && events.at(-1)?.kind === "release_superseded"
  );
}

{
  // EDB0 ACKed but never applied: HECS after the release keeps showing "enabled" (settings poll ~180 s)
  const simulation = buyingFor(nightBuying);
  endWindow(simulation);
  stepAt(simulation, 6_500, { hallBatteryAmps: 11 });
  stepAt(simulation, CONFIRM_AFTER_WRITE_MS, batsAt(simulation, 10, CONFIRM_AFTER_WRITE_MS));
  const releasedAtMs = CONFIRM_AFTER_WRITE_MS;
  stepAt(simulation, releasedAtMs + 300, sentAt(simulation, "EDB0", releasedAtMs + 300));
  // EDB0's confirm and its backoff re-check, both inside the retry spacing → no retry yet
  stepAt(simulation, releasedAtMs + 12_500, hecsAt(simulation, "enabled", releasedAtMs + 12_500));
  stepAt(simulation, releasedAtMs + 42_500, hecsAt(simulation, "enabled", releasedAtMs + 42_500));
  check("EDB0's own confirm + re-check showing 'enabled' → no retry yet", edb0RetryRequests(simulation.state) === 0);
  for (const atMs of [180_000, 360_000, 540_000, 720_000, 900_000]) {
    stepAt(simulation, atMs, hecsAt(simulation, "enabled", atMs));
  }
  const retries = simulation.events
    .filter(recorded => recorded.event.kind === "edb0_retry")
    .map(recorded => recorded.atMs);
  const exhausted = lastEvent(simulation, "edb0_retries_exhausted");
  check(
    `EDB0 re-requested at most ${MAX_EDB0_RETRIES} times, ≥ ${EDB0_RETRY_SPACING_MS / 1000} s apart, then given up once`,
    retries.join() === "180000,360000" &&
      simulation.events.filter(recorded => recorded.event.kind === "edb0_retries_exhausted").length === 1 &&
      exhausted?.afterReleaseMs === 540_000 - releasedAtMs,
    `retries at ${retries.join()}`
  );
  check(
    "…naming the last read-back limit, the request count stays at the cap and nothing is held",
    exhausted?.lastLimitReadbackAmps === 10 &&
      edb0RetryRequests(simulation.state) === MAX_EDB0_RETRIES &&
      !holdsAcChargingOn(simulation.state)
  );
  stepAt(simulation, 950_000, hecsAt(simulation, "disabled", 950_000));
  check(
    "…a later 'disabled' still ends it cleanly",
    simulation.state.progress.phase === "idle" && edb0RetryRequests(simulation.state) === 0
  );
}

if (failedChecks.length) {
  console.error(`\n${failedChecks.length} check(s) FAILED:`, failedChecks.join("; "));
  process.exit(1);
}
console.log("\nAll buy-window end release checks passed");

function check(name: string, condition: boolean, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}: ${name} ${detail}`);
  if (!condition) failedChecks.push(name);
}
