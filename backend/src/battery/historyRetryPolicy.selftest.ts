/**
 * Pure self-test of the InfluxDB history retry/backoff and outage-escalation policy (no DB, no hardware).
 * Run from backend/ with:  yarn node src/battery/historyRetryPolicy.selftest.ts
 */
import process from "process";
import {
  DEFAULT_HISTORY_RETRY_TIMING,
  describeDurationMs,
  episodeAfterFailure,
  episodeHasGoneQuiet,
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

// ---------- backoff: 30 s, then a 60 s cap ----------
{
  const delays = [1, 2, 3, 4, 40].map(failedAttempts => retryDelayAfterFailures(failedAttempts, timing));
  check(
    "delays: 30 s, then capped at 60 s",
    JSON.stringify(delays) === JSON.stringify([30_000, 60_000, 60_000, 60_000, 60_000]),
    JSON.stringify(delays)
  );
  check("a huge failure count stays at the cap", retryDelayAfterFailures(10_000, timing) === minute);
  check("0 failures (defensive) is the first delay, not half of it", retryDelayAfterFailures(0, timing) === 30_000);
  check(
    "the first retry outlasts node-influx's 10 s host-disable backoff (else retries never reach the network)",
    timing.firstRetryDelayMs > 10_000
  );
}

// ---------- power cycles: InfluxDB is seen within a minute of answering, and pages only when it should ----------
{
  let elapsedMs = 0;
  const attemptTimes: number[] = [0];
  for (let failedAttempts = 1; elapsedMs < 20 * minute; failedAttempts++) {
    elapsedMs += retryDelayAfterFailures(failedAttempts, timing);
    attemptTimes.push(elapsedMs);
  }
  const firstAttemptAtOrAfter = (answersAtMs: number) => attemptTimes.find(attemptAt => attemptAt >= answersAtMs)!;
  const attemptsText = `attempts at ${attemptTimes.map(attemptAt => describeDurationMs(attemptAt)).join(", ")}`;
  check(
    "VM up at 7.6 min → seen within a minute",
    firstAttemptAtOrAfter(7.6 * minute) - 7.6 * minute <= minute,
    attemptsText
  );
  check(
    "VM up at 12.6 min → seen before the 15-min escalation (no false page)",
    firstAttemptAtOrAfter(12.6 * minute) < timing.escalateAfterMs
  );
  check("escalation sits clear of the VM's 7–10 min boot", timing.escalateAfterMs >= 12 * minute);
}

// ---------- outage episodes ----------
{
  const opened = episodeAfterFailure(undefined, 1_000, timing);
  check(
    "the first failure opens an episode at its time",
    opened.startedAtMs === 1_000 && opened.lastFailureAtMs === 1_000 && opened.failedAttempts === 1 && !opened.escalated
  );
  const continued = episodeAfterFailure(episodeAfterFailure(opened, 31_000, timing), 91_000, timing);
  check(
    "later failures count, keep the start and move the last-failure time",
    continued.startedAtMs === 1_000 && continued.failedAttempts === 3 && continued.lastFailureAtMs === 91_000,
    JSON.stringify(continued)
  );
  check("episodeAfterFailure doesn't mutate its input", opened.failedAttempts === 1);
}

// ---------- an episode whose failing queries were cancelled goes quiet instead of escalating ----------
{
  // Worst gap of a query still retrying: a full-cap wait, then an attempt that runs into the request timeout.
  const worstRetryGapMs = timing.maxRetryDelayMs + timing.requestTimeoutMs;
  const episode: OutageEpisode = { startedAtMs: 0, lastFailureAtMs: 2 * minute, failedAttempts: 6, escalated: false };
  check(
    "a still-retrying query's worst gap doesn't count as quiet",
    !episodeHasGoneQuiet(episode, 2 * minute + worstRetryGapMs, timing)
  );
  check(
    "a main() crash-restart (10 s, then the queries fail again) keeps the episode",
    !episodeHasGoneQuiet(episode, 2 * minute + 15_000, timing) &&
      episodeAfterFailure(episode, 2 * minute + 15_000, timing).startedAtMs === 0
  );
  check(
    "no failure for twice that worst gap → quiet (the live anchor cancelled the retrying integral)",
    episodeHasGoneQuiet(episode, 2 * minute + 2 * worstRetryGapMs + 1, timing)
  );
  const escalatedAndStale: OutageEpisode = { ...episode, escalated: true };
  const nextOutage = episodeAfterFailure(escalatedAndStale, 3 * 60 * minute, timing);
  check(
    "a later outage opens a fresh episode instead of joining the stale escalated one",
    nextOutage.startedAtMs === 3 * 60 * minute && nextOutage.failedAttempts === 1 && !nextOutage.escalated,
    JSON.stringify(nextOutage)
  );
  check(
    "… and gets its own escalation clock",
    msUntilEscalation(nextOutage, 3 * 60 * minute, timing) === timing.escalateAfterMs
  );
}

// ---------- escalation: once per episode, at escalateAfterMs ----------
{
  const startedAtMs = 5_000;
  const episode: OutageEpisode = { startedAtMs, lastFailureAtMs: startedAtMs, failedAttempts: 4, escalated: false };
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
  const nextEpisode = episodeAfterFailure(undefined, startedAtMs + 60 * minute, timing);
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
