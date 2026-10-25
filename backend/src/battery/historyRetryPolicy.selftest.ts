/**
 * Pure self-test of the InfluxDB history retry/backoff and outage-escalation policy (no DB, no hardware).
 * Run from backend/ with:  yarn node src/battery/historyRetryPolicy.selftest.ts
 */
import process from "process";
import {
  DEFAULT_HISTORY_RETRY_TIMING,
  describeDurationMs,
  episodeAfterFailure,
  msUntilEscalation,
  type OutageEpisode,
  retryDelayAfterFailures,
} from "./historyRetryPolicy.ts";

const fails: string[] = [];
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name} ${detail}`);
  if (!cond) fails.push(name);
}

const timing = DEFAULT_HISTORY_RETRY_TIMING;
const minute = 60_000;

// ---------- backoff: 30 s doubling, capped at 5 min ----------
{
  const delays = [1, 2, 3, 4, 5, 6, 40].map(failedAttempts => retryDelayAfterFailures(failedAttempts, timing));
  check(
    "delays double from 30 s and cap at 5 min",
    JSON.stringify(delays) === JSON.stringify([30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000]),
    JSON.stringify(delays)
  );
  check("a huge failure count stays at the cap", retryDelayAfterFailures(10_000, timing) === 5 * minute);
  check("0 failures (defensive) is the first delay, not half of it", retryDelayAfterFailures(0, timing) === 30_000);
  check(
    "the first retry outlasts node-influx's 10 s host-disable backoff (else retries never reach the network)",
    timing.firstRetryDelayMs > 10_000
  );
}

// ---------- a typical power cycle: the VM answers ~8 min in, well before escalation ----------
{
  let elapsedMs = 0;
  const attemptTimes: number[] = [0];
  for (let failedAttempts = 1; elapsedMs < 20 * minute; failedAttempts++) {
    elapsedMs += retryDelayAfterFailures(failedAttempts, timing);
    attemptTimes.push(elapsedMs);
  }
  const firstAttemptAfterVmUp = attemptTimes.find(attemptAt => attemptAt >= 8 * minute)!;
  check(
    "VM up at 8 min → the next retry lands within one capped delay (SOC known by ~12.5 min)",
    firstAttemptAfterVmUp - 8 * minute <= timing.maxRetryDelayMs && firstAttemptAfterVmUp < timing.escalateAfterMs,
    `attempts at ${attemptTimes.map(attemptAt => describeDurationMs(attemptAt)).join(", ")}`
  );
  check("escalation sits clear of the VM's 7–10 min boot", timing.escalateAfterMs >= 12 * minute);
}

// ---------- outage episodes ----------
{
  const opened = episodeAfterFailure(undefined, 1_000);
  check(
    "the first failure opens an episode at its time",
    opened.startedAtMs === 1_000 && opened.failedAttempts === 1 && !opened.escalated
  );
  const continued = episodeAfterFailure(episodeAfterFailure(opened, 31_000), 91_000);
  check(
    "later failures count but keep the start",
    continued.startedAtMs === 1_000 && continued.failedAttempts === 3,
    JSON.stringify(continued)
  );
  check("episodeAfterFailure doesn't mutate its input", opened.failedAttempts === 1);
}

// ---------- escalation: once per episode, at escalateAfterMs ----------
{
  const startedAtMs = 5_000;
  const episode: OutageEpisode = { startedAtMs, failedAttempts: 4, escalated: false };
  check("no episode → nothing to escalate", msUntilEscalation(undefined, startedAtMs, timing) === undefined);
  check(
    "just opened → wait the full 15 min",
    msUntilEscalation(episode, startedAtMs, timing) === 15 * minute,
    String(msUntilEscalation(episode, startedAtMs, timing))
  );
  check(
    "10 min in (VM still booting) → 5 min left, no escalation yet",
    msUntilEscalation(episode, startedAtMs + 10 * minute, timing) === 5 * minute
  );
  check("at 15 min → due now", msUntilEscalation(episode, startedAtMs + 15 * minute, timing) === 0);
  check("past 15 min → overdue (≤ 0)", msUntilEscalation(episode, startedAtMs + 40 * minute, timing)! < 0);
  check(
    "already escalated → never again in this episode",
    msUntilEscalation({ ...episode, escalated: true }, startedAtMs + 40 * minute, timing) === undefined
  );
  const nextEpisode = episodeAfterFailure(undefined, startedAtMs + 60 * minute);
  check(
    "a new episode after an answer escalates afresh",
    msUntilEscalation(nextEpisode, startedAtMs + 60 * minute, timing) === 15 * minute
  );
}

// ---------- duration wording for the log lines ----------
check("ms wording", describeDurationMs(850) === "850 ms", describeDurationMs(850));
check("seconds wording", describeDurationMs(42_300) === "42 s", describeDurationMs(42_300));
check("minutes wording", describeDurationMs(9.4 * minute) === "9.4 min", describeDurationMs(9.4 * minute));

console.log(
  `\n${fails.length ? `${fails.length} FAILED: ${fails.join(", ")}` : "all historyRetryPolicy selftests passed"}`
);
process.exit(fails.length ? 1 : 0);
