/**
 * Self-test of the buy schedule's per-entry timing (scheduledBuyWatts.ts) when a running window's end_time
 * moves under the same key, as a re-plan reshaping a running hold does (runningHold.ts): extended, the old end
 * mustn't cut the window and the watts mustn't pass through 0; shortened, it ends at the new end, not the old;
 * shortened into the past, it ends at once without the start firing again. Real timers, ~1 s. Run from
 * backend/ with:
 *   yarn node src/buying/scheduledBuyWatts.selftest.ts
 */
import process from "process";
import { createEffect, createRoot, createSignal } from "solid-js";
import { scheduledBuyWattsPerEntry } from "./scheduledBuyWatts.ts";
import type { Config } from "../config/config.types.ts";

type BuySchedule = Config["scheduled_power_buying"]["schedule"];

const failedChecks: string[] = [];
function check(name: string, passed: boolean, detail = "") {
  console.log(`${passed ? "PASS" : "FAIL"}: ${name} ${detail}`);
  if (!passed) failedChecks.push(name);
}

const HOLD_WATTS = 100;
const startedMs = Date.now();
const startKey = new Date(startedMs - 60_000).toISOString();

// ---------- Extended while running: runs on past the old end, never through 0 ----------
{
  const run = runningWindow(startedMs + 400);
  await waitUntil(startedMs + 150);
  run.setEnd(startedMs + 800);
  await waitUntil(startedMs + 600);
  const atOldEndPassed = run.watts();
  await waitUntil(startedMs + 950);
  check("extended: still running after the old end", atOldEndPassed === HOLD_WATTS, `(${atOldEndPassed} W)`);
  check("extended: ends at the new end", run.watts() === 0, `(${run.watts()} W)`);
  check(
    "extended: the watts never passed through 0 before the new end",
    run.seen.every(sample => sample.watts === HOLD_WATTS || sample.atMs >= startedMs + 790),
    `(${JSON.stringify(run.seen.map(sample => [sample.atMs - startedMs, sample.watts]))})`
  );
  run.dispose();
}

// ---------- Shortened while running: ends at the new end, not the old ----------
{
  const shortenedAtMs = Date.now();
  const run = runningWindow(shortenedAtMs + 800);
  await waitUntil(shortenedAtMs + 100);
  run.setEnd(shortenedAtMs + 300);
  await waitUntil(shortenedAtMs + 450);
  check("shortened: off at the new end", run.watts() === 0, `(${run.watts()} W)`);
  await waitUntil(shortenedAtMs + 900);
  check(
    "shortened: nothing switched it back on, the old end's timer included",
    run.seen.filter(sample => sample.atMs > shortenedAtMs + 310).every(sample => sample.watts === 0),
    `(${JSON.stringify(run.seen.map(sample => [sample.atMs - shortenedAtMs, sample.watts]))})`
  );
  run.dispose();
}

// ---------- Shortened into the past: off at once, the start doesn't fire again ----------
{
  const cutAtMs = Date.now();
  const run = runningWindow(cutAtMs + 800);
  await waitUntil(cutAtMs + 100);
  const cutMs = Date.now();
  run.setEnd(cutAtMs - 1_000);
  const offAtMs = run.seen.find(sample => sample.watts === 0)?.atMs;
  await waitUntil(cutAtMs + 300);
  const firstOff = run.seen.findIndex(sample => sample.watts === 0);
  check(
    "ended in the past: off in the same tick and stays off",
    offAtMs !== undefined &&
      offAtMs - cutMs < 20 &&
      firstOff >= 0 &&
      run.seen.slice(firstOff).every(sample => sample.watts === 0),
    `(${JSON.stringify(run.seen.map(sample => [sample.atMs - cutAtMs, sample.watts]))})`
  );
  run.dispose();
}

console.log(failedChecks.length ? `\n${failedChecks.length} FAILURES: ${failedChecks.join(", ")}` : "\nAll passed");
process.exit(failedChecks.length ? 1 : 0);

/** A hold-power entry that started a minute ago, its wanted watts observed on every change */
function runningWindow(endMs: number): {
  setEnd: (endMs: number) => void;
  watts: () => number;
  seen: { atMs: number; watts: number }[];
  dispose: () => void;
} {
  return createRoot(dispose => {
    const [schedule, setSchedule] = createSignal<BuySchedule>({
      [startKey]: { end_time: new Date(endMs).toISOString(), charging_power: HOLD_WATTS },
    });
    const perEntry = scheduledBuyWattsPerEntry(schedule);
    const watts = () => perEntry()[0]?.()() ?? 0;
    const seen: { atMs: number; watts: number }[] = [];
    createEffect(() => seen.push({ atMs: Date.now(), watts: watts() }));
    return {
      setEnd: newEndMs =>
        setSchedule(previous => ({
          ...previous,
          [startKey]: { ...previous[startKey], end_time: new Date(newEndMs).toISOString() },
        })),
      watts,
      seen,
      dispose,
    };
  });
}

function waitUntil(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms - Date.now())));
}
