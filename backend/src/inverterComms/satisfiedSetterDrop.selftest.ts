/**
 * Pure self-test: queued setters are desired state — one the latest trustworthy readback already
 * satisfies is withdrawn, so an abandoned target can't land when its identical-setter gate opens
 * (review of PR #48, finding 6). Run from backend/ with:
 *   yarn node src/inverterComms/satisfiedSetterDrop.selftest.ts
 */
import process from "process";
import {
  afterConfirmRun,
  afterSetterSent,
  decideNextAction,
  hasEligibleSetter,
  initialSchedulerState,
  readbackAlreadySatisfies,
  withSettingsReadback,
  withSetterDequeued,
  withSetterQueued,
  type SchedulerState,
} from "./schedulerCore.ts";

const fails: string[] = [];
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name} ${detail}`);
  if (!cond) fails.push(name);
}

const seconds = (value: number) => value * 1000;
const SETTINGS_POLL_INTERVAL_MS = seconds(300);
const gpmpReadback = (watts: number) => ({ maximum_feeding_grid_power: watts });

function send(state: SchedulerState, command: string, prefix: string, atMs: number): SchedulerState {
  const queued = withSetterQueued(state, command, prefix, atMs);
  return afterSetterSent(withSetterDequeued(queued, command), command, ["GPMP"], atMs, true);
}
/** Every send_setter decision between `fromMs` and `toMs` (1 s steps), applying drops as the session does */
function setterSendsBetween(state: SchedulerState, fromMs: number, toMs: number): string[] {
  const sends: string[] = [];
  let current = state;
  for (let nowMs = fromMs; nowMs <= toMs; nowMs += 1000) {
    const decision = decideNextAction(current, nowMs, SETTINGS_POLL_INTERVAL_MS);
    if (decision.action === "drop_setter") current = withSetterDequeued(current, decision.command);
    if (decision.action === "send_setter") {
      sends.push(`${decision.command}@${nowMs / 1000}s`);
      current = withSetterDequeued(current, decision.command);
    }
  }
  return sends;
}

// ---------- the reviewer's GPMP 1290 scenario ----------
{
  let state = initialSchedulerState();
  state = send(state, "GPMP001290", "GPMP0", seconds(0)); // t=0: spike target sent
  state = send(state, "GPMP000290", "GPMP0", seconds(5)); // t=5: back to 290 (different string, not gated)
  state = withSetterQueued(state, "GPMP001290", "GPMP0", seconds(10)); // t=10: 1290 again → gated to t=60
  check("setup: 1290 is gated to t=60", state.queuedSetters[0]?.notBefore === seconds(60));
  // t=17: the confirm run decodes GPMP = 290 (recorded as a readback, then evaluated)
  state = withSettingsReadback(state, "GPMP", gpmpReadback(290), seconds(17));
  state = afterConfirmRun(state, { GPMP: gpmpReadback(290) }, seconds(17)).state;
  // t=20: the consumer's target is 290 again — matching the readback — and it queues that desired state
  state = withSetterQueued(state, "GPMP000290", "GPMP0", seconds(20));
  const decision = decideNextAction(state, seconds(20), SETTINGS_POLL_INTERVAL_MS);
  check(
    "the satisfied desired state replaces the stale 1290 and is dropped unsent",
    decision.action === "drop_setter" && decision.command === "GPMP000290",
    JSON.stringify(decision)
  );
  const sends = setterSendsBetween(state, seconds(20), seconds(120));
  check("1290 never goes out when its gate opens at t=60 (nor anything else)", sends.length === 0, sends.join(", "));
}

// ---------- the milder variant: identical re-queue while a confirm is pending ----------
{
  let state = initialSchedulerState();
  state = send(state, "GPMP001290", "GPMP0", seconds(0));
  state = withSetterQueued(state, "GPMP001290", "GPMP0", seconds(3)); // re-queued before the readback shows it
  check("identical re-queue is gated to t=60", state.queuedSetters[0]?.notBefore === seconds(60));
  // t=12: the confirm sees 1290 applied
  state = withSettingsReadback(state, "GPMP", gpmpReadback(1290), seconds(12));
  state = afterConfirmRun(state, { GPMP: gpmpReadback(1290) }, seconds(12)).state;
  const sends = setterSendsBetween(state, seconds(12), seconds(120));
  check("the redundant identical write is withdrawn instead of sent at t=60", sends.length === 0, sends.join(", "));
}

// ---------- a readback is only trusted when it can stand in for the inverter's state ----------
{
  // A readback older than the latest write touching that query proves nothing
  let state = initialSchedulerState();
  state = withSettingsReadback(state, "GPMP", gpmpReadback(290), seconds(0));
  state = send(state, "GPMP001290", "GPMP0", seconds(1)); // confirm pending; the inverter may commit 1290
  state = withSetterQueued(state, "GPMP000290", "GPMP0", seconds(2)); // the target moved back to 290
  const decision = decideNextAction(state, seconds(2), SETTINGS_POLL_INTERVAL_MS);
  check(
    "not dropped against a readback older than the last write — 290 is sent",
    decision.action === "send_setter" && decision.command === "GPMP000290",
    JSON.stringify(decision)
  );
}
{
  // A confirm still in its backoff: the ACKed write may yet commit, so the old readback can't be trusted
  let state = initialSchedulerState();
  state = withSettingsReadback(state, "GPMP", gpmpReadback(290), seconds(0));
  state = send(state, "GPMP001290", "GPMP0", seconds(1));
  state = withSettingsReadback(state, "GPMP", gpmpReadback(290), seconds(13)); // not committed yet
  const confirm = afterConfirmRun(state, { GPMP: gpmpReadback(290) }, seconds(13));
  state = confirm.state;
  check("setup: the confirm backs off", confirm.result.retry !== undefined);
  state = withSetterQueued(state, "GPMP000290", "GPMP0", seconds(14));
  check(
    "not dropped while a confirm on that field is pending",
    !readbackAlreadySatisfies(state, "GPMP000290") && hasEligibleSetter(state, seconds(14))
  );
}
{
  // Other queries' writes don't make an unrelated readback untrustworthy
  let state = initialSchedulerState();
  state = withSettingsReadback(
    state,
    "HECS",
    { battery_discharge_to_feed_grid_when_solar_input_normal: "enabled" },
    seconds(5)
  );
  state = afterSetterSent(state, "GPMP000350", ["GPMP"], seconds(6), true);
  state = afterConfirmRun(
    withSettingsReadback(state, "GPMP", gpmpReadback(350), seconds(18)),
    { GPMP: gpmpReadback(350) },
    seconds(18)
  ).state;
  check("a HECS readback is still trusted after a GPMP write", readbackAlreadySatisfies(state, "EDF1"));
  check("…and doesn't satisfy the opposite value", !readbackAlreadySatisfies(state, "EDF0"));
}
{
  let state = initialSchedulerState();
  state = withSettingsReadback(state, "GPMP", gpmpReadback(350), seconds(1));
  state = withSetterQueued(state, "GPMP000350", "GPMP0", seconds(2));
  check("a satisfied setter does not preempt a running poll round", !hasEligibleSetter(state, seconds(2)));
  check(
    "a setter without a readback mapping is never considered satisfied",
    !readbackAlreadySatisfies(state, "DAT261025120000")
  );
  check(
    "no readback yet → not satisfied (boot: MUCHGC0100 still goes out)",
    !readbackAlreadySatisfies(initialSchedulerState(), "MUCHGC0100")
  );
}

// ---------- delta review: HECS readbacks are trusted per field, not per query ----------
const hecsReadback = (feedNormal: string, feedLoss: string, acCharge = "disabled") => ({
  battery_discharge_to_feed_grid_when_solar_input_normal: feedNormal,
  battery_discharge_to_feed_grid_when_solar_input_loss: feedLoss,
  ac_charge_battery: acCharge,
});
/** The pump's decisions at `atMs` until it would wait/poll/confirm: drops applied, setters "sent" and ACKed */
function pumpSetters(state: SchedulerState, atMs: number, log: string[]): SchedulerState {
  let current = state;
  for (let iteration = 0; iteration < 20; iteration++) {
    const decision = decideNextAction(current, atMs, SETTINGS_POLL_INTERVAL_MS);
    if (decision.action === "drop_setter") {
      log.push(`drop ${decision.command}@${atMs / 1000}s`);
      current = withSetterDequeued(current, decision.command);
    } else if (decision.action === "send_setter") {
      log.push(`send ${decision.command}@${atMs / 1000}s`);
      current = afterSetterSent(withSetterDequeued(current, decision.command), decision.command, ["HECS"], atMs, true);
    } else {
      return current;
    }
  }
  throw new Error("pump did not settle");
}
{
  // Evening feed starts with G already enabled; the effect re-runs 5 s into EDF1's quiet gap
  const log: string[] = [];
  let state = withSettingsReadback(initialSchedulerState(), "HECS", hecsReadback("disabled", "enabled"), seconds(0));
  state = withSetterQueued(state, "EDG1", "EDG", seconds(1));
  state = withSetterQueued(state, "EDF1", "EDF", seconds(1));
  state = pumpSetters(state, seconds(1), log);
  state = withSetterQueued(state, "EDG1", "EDG", seconds(6));
  state = withSetterQueued(state, "EDF1", "EDF", seconds(6));
  state = pumpSetters(state, seconds(6), log);
  check(
    "EDG1 re-queued 5 s into EDF1's quiet gap, G already enabled → dropped, not sent",
    log.join(", ") === "drop EDG1@1s, send EDF1@1s, drop EDG1@6s",
    log.join(", ")
  );
  check(
    "…and the identical EDF1 re-queue stays behind its 60 s gate",
    state.queuedSetters[0]?.notBefore === seconds(61)
  );
}
{
  // Buying's EDB0 queued during an EDF/EDG flip, the readback already showing AC charging disabled
  const log: string[] = [];
  let state = withSettingsReadback(initialSchedulerState(), "HECS", hecsReadback("disabled", "disabled"), seconds(0));
  state = withSetterQueued(state, "EDF1", "EDF", seconds(1));
  state = withSetterQueued(state, "EDG1", "EDG", seconds(1));
  state = pumpSetters(state, seconds(1), log);
  state = withSetterQueued(state, "EDB0", "EDB", seconds(4));
  state = pumpSetters(state, seconds(4), log);
  check(
    "EDB0 queued during an EDF/EDG flip, ac_charge_battery already disabled → dropped, not sent",
    log.join(", ") === "send EDF1@1s, send EDG1@1s, drop EDB0@4s",
    log.join(", ")
  );
}
{
  // Per field still means per field: a flag written after the readback can't be vouched for
  const log: string[] = [];
  let state = withSettingsReadback(initialSchedulerState(), "HECS", hecsReadback("disabled", "disabled"), seconds(0));
  state = withSetterQueued(state, "EDF1", "EDF", seconds(1));
  state = pumpSetters(state, seconds(1), log);
  state = withSetterQueued(state, "EDF0", "EDF", seconds(2)); // target flips back while EDF1 may still commit
  state = pumpSetters(state, seconds(2), log);
  check(
    "EDF0 right after EDF1 is sent, although the older readback shows F disabled",
    log.join(", ") === "send EDF1@1s, send EDF0@2s",
    log.join(", ")
  );
}

{
  // A NAKed or unanswered write arms no confirm check: only the per-field write time stops the
  // pre-write readback from vouching for that field
  let state = withSettingsReadback(initialSchedulerState(), "HECS", hecsReadback("disabled", "disabled"), seconds(0));
  state = afterSetterSent(state, "EDF1", ["HECS"], seconds(7.6), false);
  state = withSetterQueued(state, "EDF0", "EDF", seconds(8));
  const decision = decideNextAction(state, seconds(8), SETTINGS_POLL_INTERVAL_MS);
  check(
    "EDF0 after an unanswered/NAKed EDF1 is sent, not dropped against the pre-write readback",
    decision.action === "send_setter" && decision.command === "EDF0",
    JSON.stringify(decision)
  );
}
{
  // The same for BATS: an unanswered MCHGV may still have committed
  const batsReadback = { "battery_constant_charge_voltage(c.v.)": 56, battery_floating_charge_voltage: 56 };
  let state = withSettingsReadback(initialSchedulerState(), "BATS", batsReadback, seconds(0));
  state = afterSetterSent(state, "MCHGV0580,0580", ["BATS"], seconds(5), false);
  state = withSetterQueued(state, "MCHGV0560,0560", "MCHGV", seconds(6));
  const decision = decideNextAction(state, seconds(6), SETTINGS_POLL_INTERVAL_MS);
  check(
    "MCHGV0560,0560 after an unanswered MCHGV0580,0580 is sent, not dropped against the pre-write BATS",
    decision.action === "send_setter" && decision.command === "MCHGV0560,0560",
    JSON.stringify(decision)
  );
}

// ---------- delta review: an identical re-queue made while that setter is on the wire ----------
{
  let state = withSettingsReadback(initialSchedulerState(), "HECS", hecsReadback("disabled", "disabled"), seconds(0));
  state = withSetterQueued(state, "EDF1", "EDF", seconds(1));
  const firstDecision = decideNextAction(state, seconds(1), SETTINGS_POLL_INTERVAL_MS);
  check("setup: EDF1 is sent at t=1", firstDecision.action === "send_setter" && firstDecision.command === "EDF1");
  state = withSetterDequeued(state, "EDF1"); // the session dequeues, then awaits the exchange…
  state = withSetterQueued(state, "EDF1", "EDF", seconds(1.2)); // …during which the effect re-queues it
  state = afterSetterSent(state, "EDF1", ["HECS"], seconds(1.3), true); // ACK at t=1.3
  const afterAck = decideNextAction(state, seconds(1.3), SETTINGS_POLL_INTERVAL_MS);
  check(
    "the copy re-queued mid-send is not sent at t=1.3 (re-gated from this send)",
    afterAck.action !== "send_setter" && state.queuedSetters[0]?.notBefore === seconds(61.3),
    `${JSON.stringify(afterAck)} queued ${JSON.stringify(state.queuedSetters)}`
  );
  // Converged: the confirm readback shows F enabled → the copy is withdrawn
  const converged = afterConfirmRun(
    withSettingsReadback(state, "HECS", hecsReadback("enabled", "disabled"), seconds(13.3)),
    { HECS: hecsReadback("enabled", "disabled") },
    seconds(13.3)
  );
  const afterConfirm = decideNextAction(converged.state, seconds(13.4), SETTINGS_POLL_INTERVAL_MS);
  check(
    "…and withdrawn once the confirm shows it applied",
    converged.result.confirmedChecks.length === 1 &&
      converged.result.retry === undefined &&
      afterConfirm.action === "drop_setter" &&
      afterConfirm.command === "EDF1"
  );
  // Never applied: after the confirm gives up, the copy may go out — but not before the 60 s gate
  let gaveUp = withSettingsReadback(state, "HECS", hecsReadback("disabled", "disabled"), seconds(13.3));
  gaveUp = afterConfirmRun(gaveUp, { HECS: hecsReadback("disabled", "disabled") }, seconds(13.3)).state;
  gaveUp = withSettingsReadback(gaveUp, "HECS", hecsReadback("disabled", "disabled"), seconds(43.3));
  gaveUp = afterConfirmRun(gaveUp, { HECS: hecsReadback("disabled", "disabled") }, seconds(43.3)).state;
  const sendsAfterGiveUp = setterSendsBetween(gaveUp, seconds(44), seconds(70));
  check(
    "…or, if it never applied, re-sent no earlier than 60 s after the previous send",
    sendsAfterGiveUp.length === 1 && sendsAfterGiveUp[0] === "EDF1@62s",
    sendsAfterGiveUp.join(", ")
  );
}

{
  // A DIFFERENT target queued while EDF1 is on the wire keeps its own gate: the newest desired
  // state must replace the old one at once, never wait behind the old one's 60 s gate
  let state = withSettingsReadback(initialSchedulerState(), "HECS", hecsReadback("disabled", "disabled"), seconds(0));
  state = withSetterQueued(state, "EDF1", "EDF", seconds(1));
  state = withSetterDequeued(state, "EDF1");
  state = withSetterQueued(state, "EDF0", "EDF", seconds(1.2));
  state = afterSetterSent(state, "EDF1", ["HECS"], seconds(1.3), true);
  const afterAck = decideNextAction(state, seconds(1.3), SETTINGS_POLL_INTERVAL_MS);
  check(
    "EDF0 queued while EDF1 is on the wire goes out right after the ACK",
    afterAck.action === "send_setter" && afterAck.command === "EDF0",
    JSON.stringify(afterAck)
  );
}

console.log(
  `\n${fails.length ? `${fails.length} FAILED: ${fails.join(", ")}` : "all satisfiedSetterDrop selftests passed"}`
);
process.exit(fails.length ? 1 : 0);
