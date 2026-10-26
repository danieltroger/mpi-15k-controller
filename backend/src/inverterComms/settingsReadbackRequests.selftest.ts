/**
 * Pure self-test of a consumer's settings readback request (settingsReadbackRequests.ts) through the
 * scheduler: it makes poll rounds settings rounds until its query decodes — a round a setter cut short,
 * or one whose BATS went unanswered, doesn't use it up (#70's review) — waits out a silent confirm phase,
 * and lapses after SETTINGS_READBACK_REQUEST_LIFETIME_MS.
 * Run from backend/ with:  yarn node src/inverterComms/settingsReadbackRequests.selftest.ts
 */
import process from "process";
import {
  afterPollRound,
  afterSetterSent,
  decideNextAction,
  initialSchedulerState,
  type SchedulerState,
  withSettingsReadback,
  withSettingsReadbackRequested,
} from "./schedulerCore.ts";
import { SETTINGS_READBACK_REQUEST_LIFETIME_MS } from "./schedulerTiming.ts";
import type { DecodedFields } from "./pi17Protocol.types.ts";

const failedChecks: string[] = [];
const SETTINGS_POLL_INTERVAL_MS = 180_000;
const POLL_ROUND_MS = 1_100;

/** A session that has just finished a settings round at 0, so the interval puts the next one at 180 s */
const afterSettingsRound = settingsRoundAt(initialSchedulerState(), 0, ["GPMP", "HECS", "BATS"]);

check("no request: rounds within the interval read GS/PS only", includesSettings(afterSettingsRound, 10_000) === false);
const requested = withSettingsReadbackRequested(afterSettingsRound, "BATS", 10_000);
check("a BATS request makes the next round a settings round", includesSettings(requested, 10_000) === true);

// A setter cut the round short after GS/PS, or BATS went unanswered: the round counts as a settings round
// for the interval, but BATS never decoded — the request stays open
const preempted = settingsRoundAt(requested, 10_000, []);
const unanswered = settingsRoundAt(requested, 10_000, ["GPMP", "HECS"]);
check(
  "a round that didn't decode BATS (preempted, or BATS unanswered) leaves the request open",
  includesSettings(preempted, 13_000) === true && includesSettings(unanswered, 13_000) === true
);
check(
  "…until BATS decodes: then rounds are GS/PS only again",
  includesSettings(settingsRoundAt(unanswered, 13_000, ["GPMP", "HECS", "BATS"]), 15_000) === false
);
check(
  "a BATS readback from a write's confirm answers it as well",
  includesSettings(withSettingsReadback(requested, "BATS", batsFields(10), 10_500), 11_200) === false
);
check(
  "a request lapses after its lifetime even if BATS never decodes",
  includesSettings(preempted, 10_000 + SETTINGS_READBACK_REQUEST_LIFETIME_MS - 1) === true &&
    includesSettings(preempted, 10_000 + SETTINGS_READBACK_REQUEST_LIFETIME_MS) === false
);

{
  // A silent confirm phase (the default 12 s gap) holds every poll round off; the request waits it out
  const writtenAtMs = 20_000;
  const silent = afterSetterSent(requested, "GPMP001000", ["GPMP"], writtenAtMs, true);
  const duringSilence = decideNextAction(silent, writtenAtMs + 5_000, SETTINGS_POLL_INTERVAL_MS);
  check("a silent confirm phase holds the requested round off", duringSilence.action === "wait");
  const confirmed = withSettingsReadback(
    { ...silent, confirm: undefined },
    "GPMP",
    { maximum_feeding_grid_power: 1_000 },
    writtenAtMs + 12_500
  );
  check(
    "…and the round after it reads the settings (the GPMP confirm didn't answer BATS)",
    includesSettings(confirmed, writtenAtMs + 13_000) === true
  );
}

if (failedChecks.length) {
  console.error(`\n${failedChecks.length} check(s) FAILED:`, failedChecks.join("; "));
  process.exit(1);
}
console.log("\nAll settings readback request checks passed");

function check(name: string, condition: boolean, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}: ${name} ${detail}`);
  if (!condition) failedChecks.push(name);
}

/** Whether the scheduler's poll round at `nowMs` would read the settings (undefined if it decides something else) */
function includesSettings(state: SchedulerState, nowMs: number): boolean | undefined {
  const decision = decideNextAction(state, nowMs, SETTINGS_POLL_INTERVAL_MS);
  return decision.action === "poll_round" ? decision.includeSettingsPoll : undefined;
}

/** A settings round starting at `startedAtMs` in which only `decodedQueries` were decoded */
function settingsRoundAt(
  state: SchedulerState,
  startedAtMs: number,
  decodedQueries: readonly ("GPMP" | "HECS" | "BATS")[]
): SchedulerState {
  let afterRound = state;
  for (const query of decodedQueries) {
    const fields: DecodedFields =
      query === "BATS"
        ? batsFields(10)
        : query === "HECS"
          ? { ac_charge_battery: "disabled" }
          : { maximum_feeding_grid_power: 350 };
    afterRound = withSettingsReadback(afterRound, query, fields, startedAtMs + 500);
  }
  return afterPollRound(afterRound, {
    startedAtMs,
    endedAtMs: startedAtMs + POLL_ROUND_MS,
    includedSettingsPoll: true,
    hadFailures: decodedQueries.length < 3,
  });
}

function batsFields(limitAmps: number) {
  return { "max._ac_charging_current": limitAmps };
}
