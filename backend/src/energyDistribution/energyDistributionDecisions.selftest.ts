/**
 * Self-test of the energy-distribution decisions on the follow-ups to #91's review: the session's own
 * identical-setter gate, on its monotonic clock, decides what may be queued; a change re-arm only counts when
 * it sends something, and an episode that never sent still gets the fallback; a managed field missing from
 * the HECS answer is skipped (never written on a guess) while the fields that were read are judged, and keeps
 * an episode open so it pages. Pure, no hardware. Run from backend/ with:
 *   yarn node src/energyDistribution/energyDistributionDecisions.selftest.ts
 */
import process from "process";
import type { AlertManager } from "../alerting/alertManager.ts";
import type { DecodedFields } from "../inverterComms/pi17Protocol.types.ts";
import { IDENTICAL_SETTER_MIN_INTERVAL_MS } from "../inverterComms/schedulerTiming.ts";
import { raiseDivergenceNotLanded } from "./energyDistributionAlert.ts";
import {
  CHANGE_TRIGGERED_RETRIES_PER_EPISODE,
  type DivergenceEpisode,
  ENFORCEMENT_FALLBACK_RETRY_MS,
  nextEnforcementStep,
} from "./energyDistributionEnforcementDecisions.ts";
import { setterForDivergence } from "./energyDistributionProfile.ts";
import {
  hecsAt,
  LIVE_HECS,
  MONOTONIC_START_MS,
  newPureRun,
  PURE_START_MS,
  PURE_TIMING,
  pureStep,
  RESET_HECS,
  RESTORED_COMMANDS,
  situationAt,
} from "./energyDistributionSelftestFixtures.ts";

const fails: string[] = [];
function check(name: string, condition: boolean, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}: ${name} ${detail}`);
  if (!condition) fails.push(name);
}

/** EDD1 landed after the first round; SEP01 (NAKed) and EDE1 still differ */
const EDD_LANDED: DecodedFields = { ...RESET_HECS, battery_discharge_to_loads_when_solar_input_normal: "enabled" };
const { feed_power_to_utility: _unreadFeed, ...LIVE_WITHOUT_FEED } = LIVE_HECS;
const { solar_energy_distribution_priority: _unreadPriority, ...RESET_WITHOUT_PRIORITY } = RESET_HECS;

// ---------- identity ----------
{
  const run = newPureRun();
  const sent: string[] = [];
  let stepsWithAnEpisode = 0;
  for (let elapsedMs = 0; elapsedMs <= 3_600_000; elapsedMs += 10_000) {
    const nowMs = PURE_START_MS + elapsedMs;
    const workingModeCode = elapsedMs % 600_000 < 300_000 ? "03" : "05";
    const { step, commands } = pureStep(run, situationAt(nowMs, { ...hecsAt(nowMs, LIVE_HECS), workingModeCode }));
    sent.push(...commands);
    if (step.episode) stepsWithAnEpisode++;
  }
  check(
    "identity: an hour of matching readbacks, the working mode changing too, writes nothing and opens nothing",
    sent.length === 0 && stepsWithAnEpisode === 0,
    sent.join(",")
  );
}

// ---------- nit 1: the session's own gate, on its monotonic clock ----------
{
  const run = newPureRun();
  pureStep(run, situationAt(PURE_START_MS));
  const sends: string[] = [];
  let waitingAt10s: string | undefined;
  for (let elapsedMs = 10_000; elapsedMs <= 120_000; elapsedMs += 10_000) {
    const nowMs = PURE_START_MS + elapsedMs;
    const { step, commands } = pureStep(run, situationAt(nowMs, hecsAt(nowMs, EDD_LANDED)));
    if (elapsedMs === 10_000) waitingAt10s = step.waitingReason;
    if (commands.length) sends.push(`${elapsedMs / 1000}s:${commands.join(",")}`);
  }
  check(
    "the deferred SEP01/EDE1 go out the moment the session's gate opens (60 s after their send), not on an estimate",
    sends.join(" ") === "60s:SEP01,EDE1" && run.queuedWhileGated.length === 0,
    sends.join(" ")
  );
  check(
    "…and while deferred the card says how long the gate still holds them",
    waitingAt10s?.includes("identical-setter gate") === true && waitingAt10s.includes("within 50 s"),
    waitingAt10s
  );
}
{
  // A confirm run on a sick link held the first round 20 s in the queue: the gate runs from the real send
  const run = newPureRun();
  const first = pureStep(run, situationAt(PURE_START_MS));
  for (const command of first.commands) {
    run.gateOpensAtByCommand[command] = MONOTONIC_START_MS + 20_000 + IDENTICAL_SETTER_MIN_INTERVAL_MS;
  }
  const sends: string[] = [];
  for (let elapsedMs = 5_000; elapsedMs <= 120_000; elapsedMs += 5_000) {
    const nowMs = PURE_START_MS + elapsedMs;
    const { commands } = pureStep(run, situationAt(nowMs, hecsAt(nowMs, EDD_LANDED)));
    if (commands.length) sends.push(`${elapsedMs / 1000}s:${commands.join(",")}`);
  }
  check(
    "a round sent 20 s after it was queued: held until the gate opens at 80 s (queued + 75 s would have queued into it)",
    sends.join(" ") === "80s:SEP01,EDE1" && run.queuedWhileGated.length === 0,
    sends.join(" ")
  );
}
{
  // NTP steps the wall clock an hour forward 20 s after the first round; the monotonic clock doesn't move
  const run = newPureRun();
  pureStep(run, situationAt(PURE_START_MS));
  const NTP_STEP_MS = 3_600_000;
  const sends: string[] = [];
  let p2s = 0;
  for (let monotonicElapsedMs = 5_000; monotonicElapsedMs <= 120_000; monotonicElapsedMs += 5_000) {
    const nowMs = PURE_START_MS + monotonicElapsedMs + (monotonicElapsedMs >= 20_000 ? NTP_STEP_MS : 0);
    const { step, commands } = pureStep(
      run,
      situationAt(nowMs, {
        ...hecsAt(nowMs, EDD_LANDED),
        machineModel: { model: "050", atMs: nowMs - 1_000 },
        monotonicNowMs: MONOTONIC_START_MS + monotonicElapsedMs,
      })
    );
    if (step.raiseP2) p2s++;
    if (commands.length) sends.push(`${monotonicElapsedMs / 1000}s:${commands.join(",")}`);
  }
  check(
    "an NTP step that makes the fallback look due doesn't open the gate: SEP01/EDE1 still wait for its 60 s",
    sends.join(" ") === "60s:SEP01,EDE1" && run.queuedWhileGated.length === 0,
    sends.join(" ")
  );
  check("…(the wall-clock P2 still goes out, once)", p2s === 1);
}
{
  // DM050's reset soon after an earlier episode wrote SEP01: the session's gate still holds that one
  const run = newPureRun();
  run.gateOpensAtByCommand.SEP01 = MONOTONIC_START_MS + 30_000;
  const first = pureStep(run, situationAt(PURE_START_MS));
  const sends: string[] = [];
  for (let elapsedMs = 10_000; elapsedMs <= 60_000; elapsedMs += 10_000) {
    const nowMs = PURE_START_MS + elapsedMs;
    const { commands } = pureStep(run, situationAt(nowMs));
    if (commands.length) sends.push(`${elapsedMs / 1000}s:${commands.join(",")}`);
  }
  check(
    "a setter still gated from an earlier episode is deferred, the rest go out at once…",
    first.commands.join(",") === "EDD1,EDE1" && first.step.episode?.deferredCommands.join(",") === "SEP01"
  );
  check(
    "…and it follows when its gate opens",
    sends.join(" ") === "30s:SEP01" && run.queuedWhileGated.length === 0,
    sends.join(" ")
  );
}

// ---------- nit 3: a re-arm is spent only by an attempt that sends ----------
{
  const run = newPureRun();
  pureStep(run, situationAt(PURE_START_MS));
  // A DM return's working mode changes, seconds after the first round: every setter is still gated
  const afterFirstChange = pureStep(run, situationAt(PURE_START_MS + 3_000, { workingModeCode: "03" }));
  const afterSecondChange = pureStep(run, situationAt(PURE_START_MS + 6_000, { workingModeCode: "05" }));
  check(
    "working mode changes while every setter is gated send nothing and spend no re-arm yet",
    afterFirstChange.commands.length === 0 &&
      afterSecondChange.commands.length === 0 &&
      run.episode?.changeTriggeredRetries === 0 &&
      run.episode.deferredCommands.join(",") === RESTORED_COMMANDS,
    JSON.stringify(run.episode)
  );
  const continuation = pureStep(run, situationAt(PURE_START_MS + 60_000));
  check(
    "…the deferred continuation sends their one round once the gate opens: one re-arm for both changes",
    continuation.commands.join(",") === RESTORED_COMMANDS && run.episode?.changeTriggeredRetries === 1
  );
  const sendingChange = pureStep(run, situationAt(PURE_START_MS + 130_000, { workingModeCode: "03" }));
  check(
    "…and a change that sends at once spends one",
    sendingChange.commands.join(",") === RESTORED_COMMANDS && run.episode?.changeTriggeredRetries === 2
  );
  check("no setter was queued into the gate", run.queuedWhileGated.length === 0);
}
{
  // SEP01 still gated from an earlier episode; EDD1/EDE1 land, which re-arms: it wants only the deferred SEP01
  const run = newPureRun();
  run.gateOpensAtByCommand.SEP01 = MONOTONIC_START_MS + 30_000;
  pureStep(run, situationAt(PURE_START_MS));
  const priorityOnly = { ...LIVE_HECS, solar_energy_distribution_priority: "Battery-Load-Grid" };
  const landedChange = pureStep(run, situationAt(PURE_START_MS + 10_000, hecsAt(PURE_START_MS + 10_000, priorityOnly)));
  const continuation = pureStep(run, situationAt(PURE_START_MS + 30_000, hecsAt(PURE_START_MS + 30_000, priorityOnly)));
  check(
    "a change that only wants again what's already deferred sends nothing more and spends nothing",
    landedChange.commands.length === 0 &&
      continuation.commands.join(",") === "SEP01" &&
      run.episode?.changeTriggeredRetries === 0
  );
}
{
  // The working mode flapping every 30 s while nothing lands: every change finds its setters gated
  const run = newPureRun();
  const sendTimesSeconds: number[] = [];
  for (let elapsedMs = 0; elapsedMs <= 3_600_000; elapsedMs += 10_000) {
    const nowMs = PURE_START_MS + elapsedMs;
    const workingModeCode = Math.floor(elapsedMs / 30_000) % 2 ? "03" : "05";
    if (pureStep(run, situationAt(nowMs, { workingModeCode })).commands.length) sendTimesSeconds.push(elapsedMs / 1000);
  }
  check(
    `a flapping working mode stays bounded: the first round, ${CHANGE_TRIGGERED_RETRIES_PER_EPISODE} change rounds, then the fallback only`,
    sendTimesSeconds.join(",") === "0,60,120,180,780,1380,1980,2580,3180" &&
      run.episode?.changeTriggeredRetries === CHANGE_TRIGGERED_RETRIES_PER_EPISODE &&
      run.queuedWhileGated.length === 0,
    sendTimesSeconds.join(",")
  );
}
{
  const neverSent: DivergenceEpisode = {
    onsetMs: PURE_START_MS,
    sendRounds: 0,
    lastSendAtMs: undefined,
    lastAttemptKey: "armed on an earlier situation",
    changeTriggeredRetries: CHANGE_TRIGGERED_RETRIES_PER_EPISODE,
    deferredCommands: [],
    deferredChangeRoundUncounted: false,
    p2Raised: true,
    firstDivergences: [],
  };
  const early = nextEnforcementStep(
    neverSent,
    situationAt(PURE_START_MS + ENFORCEMENT_FALLBACK_RETRY_MS - 10_000),
    PURE_TIMING
  );
  const due = nextEnforcementStep(neverSent, situationAt(PURE_START_MS + ENFORCEMENT_FALLBACK_RETRY_MS), PURE_TIMING);
  check(
    "an episode that never sent, its re-arms spent: nothing before the fallback is due from its onset…",
    !early.send && early.waitingReason?.includes("fallback") === true,
    early.waitingReason
  );
  check(
    "…then the fallback retries it",
    due.send?.map(divergence => setterForDivergence(divergence).command).join(",") === RESTORED_COMMANDS &&
      due.episode?.lastSendAtMs === PURE_START_MS + ENFORCEMENT_FALLBACK_RETRY_MS
  );
}

// ---------- nit 4: a managed field missing from the readback ----------
{
  const run = newPureRun();
  const sent: string[] = [];
  const p2AtSeconds: number[] = [];
  let firstStep: ReturnType<typeof pureStep>["step"] | undefined;
  for (let elapsedMs = 0; elapsedMs <= 900_000; elapsedMs += 10_000) {
    const nowMs = PURE_START_MS + elapsedMs;
    const { step, commands } = pureStep(run, situationAt(nowMs, hecsAt(nowMs, LIVE_WITHOUT_FEED)));
    firstStep ??= step;
    sent.push(...commands);
    if (step.raiseP2) p2AtSeconds.push(elapsedMs / 1000);
  }
  check(
    "EDC missing from the answer, the rest matching: nothing written, but an episode opens saying why",
    sent.length === 0 &&
      firstStep?.started === true &&
      firstStep.episode !== undefined &&
      firstStep.judged?.unreadFields.join(",") === "feed_power_to_utility" &&
      firstStep.waitingReason?.includes("lacks Feed to the utility (EDC)") === true,
    firstStep?.waitingReason
  );
  check(
    "…and it pages once, p2_after_minutes after the onset",
    p2AtSeconds.join(",") === String(PURE_TIMING.p2AfterMs / 1000),
    p2AtSeconds.join(",")
  );
  const onsetMs = run.episode?.onsetMs;
  const readAgainMs = PURE_START_MS + 910_000;
  const readDisabled = pureStep(
    run,
    situationAt(readAgainMs, hecsAt(readAgainMs, { ...LIVE_HECS, feed_power_to_utility: "disabled" }))
  );
  check(
    "read again and off: EDC1 is the episode's first attempt (no re-arm spent), the same episode",
    readDisabled.commands.join(",") === "EDC1" &&
      run.episode?.changeTriggeredRetries === 0 &&
      run.episode.onsetMs === onsetMs &&
      run.episode.firstDivergences.map(divergence => divergence.field).join(",") === "feed_power_to_utility"
  );
  const landedMs = PURE_START_MS + 920_000;
  const landed = pureStep(run, situationAt(landedMs, hecsAt(landedMs, LIVE_HECS)));
  check(
    "a complete matching readback ends it, with its P2 on record (the wiring sends the P3)",
    landed.step.landed?.p2Raised === true && run.episode === undefined
  );
}
{
  // The priority never read, EDD/EDE NAKed for an hour: they're retried, SEP never written
  const run = newPureRun();
  const sent: string[] = [];
  for (let elapsedMs = 0; elapsedMs <= 3_600_000; elapsedMs += 10_000) {
    const nowMs = PURE_START_MS + elapsedMs;
    sent.push(...pureStep(run, situationAt(nowMs, hecsAt(nowMs, RESET_WITHOUT_PRIORITY))).commands);
  }
  check(
    "an unread priority is never written on a guess, however long, while EDD/EDE beside it are",
    !sent.some(command => command.startsWith("SEP")) && sent.includes("EDD1") && sent.includes("EDE1"),
    sent.join(",")
  );
}
{
  const raised: Parameters<AlertManager["raise"]>[0][] = [];
  raiseDivergenceNotLanded(
    async alert => {
      raised.push(alert);
      return { ...alert, at: new Date(PURE_START_MS).toISOString(), delivery: "dry_run" };
    },
    {
      episodeOnsetMs: PURE_START_MS,
      nowMs: PURE_START_MS + 600_000,
      sendRounds: 0,
      judged: { profileName: "normal_hybrid", divergences: [], unreadFields: ["feed_power_to_utility"] },
      waitingReason: undefined,
    }
  );
  check(
    "the P2 names the unread field",
    raised[0]?.severity === "P2" && raised[0].message.includes("lacks Feed to the utility (EDC)"),
    raised[0]?.message
  );
}

console.log(
  `\n${fails.length ? `${fails.length} FAILED: ${fails.join(", ")}` : "all energyDistributionDecisions selftests passed"}`
);
process.exit(fails.length ? 1 : 0);
