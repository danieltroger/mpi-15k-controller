/**
 * Pure self-test: a readback must only ever be credited to a write it can actually show (PR #63's
 * delta review). The inverter commits writes in order, seconds after the ACK, so after A→B→A a
 * readback of "A" can mean "nothing committed yet" as well as "the second A committed". Crediting
 * it to the second A, or trusting a later "B" while the second A may still land, let a buy-window
 * extend-then-re-end lose its 10 A cap: MUCHGC2610 "confirmed" on the pre-step-down 261 A, a
 * settings poll's 10 A (MUCHGC0100 landing) then dropped the queued MUCHGC0100 as satisfied, and
 * MUCHGC2610 committed afterwards. Swept across the settings-poll cycle (180 s, the live
 * poll_values_interval_seconds) at 12, 14 and 18 s commits, for the default gap and for gap 0.
 * Run from backend/ with:
 *   yarn node src/inverterComms/commitAttribution.selftest.ts
 */
import process from "process";
import {
  bootedScheduler,
  commitsLandAfter,
  confirmRunsIn,
  queueSetterAt,
  readRegisters,
  registersFor,
  sendsIn,
  simulatePump,
} from "./schedulerSimulation.ts";
import { QUIET_GAP_AFTER_WRITE_MS, WRITE_COMMIT_WINDOW_MS } from "./schedulerTiming.ts";
import { chainAfterReadback, chainMayLeave, chainWithWrite, readbackProvesWrite } from "./fieldWriteChains.ts";

const fails: string[] = [];
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name} ${detail}`);
  if (!cond) fails.push(name);
}

const seconds = (value: number) => value * 1000;
/** The live config's usb_parameter_setting.poll_values_interval_seconds */
const LIVE_SETTINGS_POLL_INTERVAL_MS = seconds(180);
const LIMIT_FIELD = "max._ac_charging_current";
const CHARGING_AMPS = 261;
const CAP_AMPS = 10;

// ---------- the extend-then-re-end sweep ----------
for (const quietGapAfterWriteMs of [QUIET_GAP_AFTER_WRITE_MS, 0]) {
  for (const commitLatencyMs of [seconds(12), seconds(14), seconds(18)]) {
    const capLostAt: string[] = [];
    const creditedEarlyAt: string[] = [];
    const falseGiveUpsAt: string[] = [];
    for (let offsetSeconds = 0; offsetSeconds < LIVE_SETTINGS_POLL_INTERVAL_MS / 1000; offsetSeconds++) {
      const outcome = runWindowEnd(quietGapAfterWriteMs, commitLatencyMs, seconds(100 + offsetSeconds));
      if (outcome.finalLimitAmps !== CAP_AMPS) capLostAt.push(`+${offsetSeconds} s (${outcome.finalLimitAmps} A)`);
      if (outcome.confirmedBeforeItsCommit) creditedEarlyAt.push(`+${offsetSeconds} s`);
      if (outcome.gaveUp) falseGiveUpsAt.push(`+${offsetSeconds} s`);
    }
    const label = `gap ${quietGapAfterWriteMs}, ${commitLatencyMs / 1000} s commits`;
    check(
      `${label}: every extend-then-re-end ends at the ${CAP_AMPS} A cap`,
      capLostAt.length === 0,
      `${capLostAt.length}/180 lost the cap${capLostAt.length ? ": " + capLostAt.slice(0, 4).join(", ") : ""}`
    );
    check(
      `${label}: MUCHGC2610 is never confirmed by a readback from before its own commit`,
      creditedEarlyAt.length === 0,
      `${creditedEarlyAt.length}/180 credited early`
    );
    check(
      `${label}: every write lands, so nothing is reported never applied (an ambiguous readback resolves)`,
      falseGiveUpsAt.length === 0,
      `${falseGiveUpsAt.length}/180 false give-ups${falseGiveUpsAt.length ? ": " + falseGiveUpsAt.slice(0, 4).join(", ") : ""}`
    );
  }
}

// ---------- the chain itself ----------
{
  const capThenExtension = chainWithWrite(
    chainWithWrite(undefined, { value: 10, sentAtMs: 0 }, 261),
    { value: 261, sentAtMs: 5_000 },
    261
  );
  const stillAtStart = chainAfterReadback(capThenExtension, 261, 12_000, WRITE_COMMIT_WINDOW_MS);
  check(
    "A→B→A: 261 read back before 10 was seen proves nothing — both writes stay unproven",
    stillAtStart?.writes.length === 2 && !readbackProvesWrite(stillAtStart, { value: 261, sentAtMs: 5_000 }, 261)
  );
  check("…and a queued 10 can't be trusted against it (261 may still land)", chainMayLeave(stillAtStart, 10));
  const tenSeen = chainAfterReadback(stillAtStart, 10, 13_000, WRITE_COMMIT_WINDOW_MS);
  check(
    "a 10 readback proves the first write; the 261 is still unproven and may still land",
    tenSeen?.settledValue === 10 && tenSeen.writes.length === 1 && chainMayLeave(tenSeen, 10)
  );
  const proven = chainAfterReadback(tenSeen, 261, 17_500, WRITE_COMMIT_WINDOW_MS);
  check(
    "261 after the 10 proves the second write: nothing unproven is left",
    proven === undefined && readbackProvesWrite(proven, { value: 261, sentAtMs: 5_000 }, 261)
  );
  const neverSawTen = chainAfterReadback(stillAtStart, 261, 5_000 + WRITE_COMMIT_WINDOW_MS, WRITE_COMMIT_WINDOW_MS);
  check(
    `with 10 never seen, the ambiguity resolves once both writes are ${WRITE_COMMIT_WINDOW_MS / 1000} s old`,
    neverSawTen === undefined
  );
  const singleWrite = chainWithWrite(undefined, { value: 550, sentAtMs: 0 }, 350);
  check(
    "a plain write is proven by the first readback that shows it",
    readbackProvesWrite(
      chainAfterReadback(singleWrite, 550, 7_000, WRITE_COMMIT_WINDOW_MS),
      { value: 550, sentAtMs: 0 },
      550
    ) && !readbackProvesWrite(singleWrite, { value: 550, sentAtMs: 0 }, 350)
  );
  const repeated = chainWithWrite(
    chainWithWrite(undefined, { value: 550, sentAtMs: 0 }, 350),
    { value: 550, sentAtMs: 61_000 },
    350
  );
  check(
    "an identical re-send is proven by its value — an earlier write of the same value can't hide it",
    readbackProvesWrite(repeated, { value: 550, sentAtMs: 61_000 }, 550)
  );
}

console.log(
  `\n${fails.length ? `${fails.length} FAILED: ${fails.join(", ")}` : "all commitAttribution selftests passed"}`
);
process.exit(fails.length ? 1 : 0);

/**
 * A buy window ends at `windowEndAtMs` (cap MUCHGC0100), is extended 5 s later (MUCHGC2610) and ends
 * again 3 s after that (MUCHGC0100 queued as desired state, gated behind the first one's 60 s).
 * Every write commits `commitLatencyMs` after it went out, in order.
 */
function runWindowEnd(quietGapAfterWriteMs: number, commitLatencyMs: number, windowEndAtMs: number) {
  const boot = { BATS: { [LIMIT_FIELD]: CHARGING_AMPS } };
  const registers = registersFor(boot);
  const untilMs = windowEndAtMs + seconds(150);
  const { steps } = simulatePump({
    initial: bootedScheduler({ quietGapAfterWriteMs }, boot),
    registers,
    events: [
      queueSetterAt(windowEndAtMs, "MUCHGC0100", "MUCHGC"),
      queueSetterAt(windowEndAtMs + seconds(5), "MUCHGC2610", "MUCHGC"),
      queueSetterAt(windowEndAtMs + seconds(8), "MUCHGC0100", "MUCHGC"),
    ],
    fromMs: windowEndAtMs - seconds(1),
    untilMs,
    onSetterSent: commitsLandAfter(registers, commitLatencyMs),
    settingsPollIntervalMs: LIVE_SETTINGS_POLL_INTERVAL_MS,
  });
  const extension = sendsIn(steps, "MUCHGC2610")[0];
  const extensionConfirmed = confirmRunsIn(steps).find(run =>
    run.result.confirmedChecks.some(confirmedCheck => confirmedCheck.forCommand === "MUCHGC2610")
  );
  return {
    gaveUp: confirmRunsIn(steps).some(run => run.result.gaveUpChecks.length > 0),
    finalLimitAmps: readRegisters(registers, ["BATS"], untilMs).BATS?.[LIMIT_FIELD],
    confirmedBeforeItsCommit:
      extension !== undefined &&
      extensionConfirmed !== undefined &&
      extensionConfirmed.endedAtMs < extension.endedAtMs + commitLatencyMs,
  };
}
