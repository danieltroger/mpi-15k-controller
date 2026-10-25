/**
 * Pure self-test: a persistent plausibility-gate drop must page (errorLog → P2), a burst must not.
 * Run from backend/ with:  yarn node src/inverterComms/gateDropEscalation.selftest.ts
 */
import process from "process";
import {
  afterGateAccept,
  afterGateDrop,
  PERSISTENT_GATE_DROP_ERRORLOG_AFTER_MS,
  type GateDropEpisodes,
} from "./gateDropEscalation.ts";

const fails: string[] = [];
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name} ${detail}`);
  if (!cond) fails.push(name);
}

// A BMS trip after which every GS round reads below the gate's 40 V floor, one round per ~1.1 s
const tripProblem = ["battery_voltage=12.3 outside [40, 62]"];
const roundIntervalMs = 1_100;

check(
  "escalation threshold sits within the reviewer's 1–2 min",
  PERSISTENT_GATE_DROP_ERRORLOG_AFTER_MS >= 60_000 && PERSISTENT_GATE_DROP_ERRORLOG_AFTER_MS <= 120_000
);
{
  let episodes: GateDropEpisodes = {};
  const escalations: { atMs: number; text: string }[] = [];
  for (let nowMs = 0; nowMs <= 200_000; nowMs += roundIntervalMs) {
    const result = afterGateDrop(episodes, "GS", tripProblem, nowMs);
    episodes = result.episodes;
    if (result.escalation) escalations.push({ atMs: nowMs, text: result.escalation });
  }
  check("a sustained GS drop escalates exactly once", escalations.length === 1, `${escalations.length}`);
  check(
    "…as soon as it has lasted the threshold",
    escalations[0] !== undefined &&
      escalations[0].atMs >= PERSISTENT_GATE_DROP_ERRORLOG_AFTER_MS &&
      escalations[0].atMs < PERSISTENT_GATE_DROP_ERRORLOG_AFTER_MS + roundIntervalMs
  );
  check(
    "…naming the command, the offending field and value",
    escalations[0] !== undefined &&
      escalations[0].text.includes("GS") &&
      escalations[0].text.includes("battery_voltage=12.3 outside [40, 62]")
  );
  const ended = afterGateAccept(episodes, "GS");
  check(
    "an accepted GS round ends the episode and reports it was escalated",
    ended.endedEpisode?.escalated === true && ended.episodes.GS === undefined
  );
  const restarted = afterGateDrop(ended.episodes, "GS", tripProblem, 300_000);
  check(
    "a later drop starts a fresh, unescalated episode",
    restarted.episodes.GS?.firstDropAtMs === 300_000 && !restarted.escalation
  );
}
{
  // Line garbage: a few drops with good rounds in between never page
  let episodes: GateDropEpisodes = {};
  let escalated = false;
  for (let nowMs = 0; nowMs <= 600_000; nowMs += roundIntervalMs) {
    if (Math.floor(nowMs / roundIntervalMs) % 20 === 0) {
      const result = afterGateDrop(episodes, "GS", tripProblem, nowMs);
      episodes = result.episodes;
      escalated ||= result.escalation !== undefined;
    } else {
      episodes = afterGateAccept(episodes, "GS").episodes;
    }
  }
  check("intermittent drops (1 in 20 rounds, 10 min) never escalate", !escalated);
}
{
  // Episodes are per command: PS keeps passing while GS drops — GS still escalates
  let episodes: GateDropEpisodes = {};
  let gsEscalated = false;
  for (let nowMs = 0; nowMs <= 100_000; nowMs += roundIntervalMs) {
    const gsResult = afterGateDrop(episodes, "GS", tripProblem, nowMs);
    episodes = afterGateAccept(gsResult.episodes, "PS").episodes;
    gsEscalated ||= gsResult.escalation !== undefined;
  }
  check("PS passing doesn't reset a GS episode", gsEscalated && episodes.GS !== undefined && episodes.PS === undefined);
  check("an accept for a command without an episode is a no-op", afterGateAccept({}, "PS").endedEpisode === undefined);
}

console.log(
  `\n${fails.length ? `${fails.length} FAILED: ${fails.join(", ")}` : "all gateDropEscalation selftests passed"}`
);
process.exit(fails.length ? 1 : 0);
