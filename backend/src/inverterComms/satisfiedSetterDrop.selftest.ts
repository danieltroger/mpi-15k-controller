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
  check("setup: the confirm backs off", confirm.result.outcome === "retry");
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

console.log(
  `\n${fails.length ? `${fails.length} FAILED: ${fails.join(", ")}` : "all satisfiedSetterDrop selftests passed"}`
);
process.exit(fails.length ? 1 : 0);
