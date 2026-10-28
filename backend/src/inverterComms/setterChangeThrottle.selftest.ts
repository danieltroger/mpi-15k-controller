/**
 * Self-test of the setter write throttle (setterChangeThrottle.ts), pure: noise gets at most one write per
 * interval, a large decrease and a mode change (window start/end) go out at once, the knobs apply live and
 * are bounds-checked, and a replay of the 2026-10-27 buy window's logged targets (545 MUCHGC writes
 * unthrottled). The same rules in the buying setters' reactive graph: buyingSetterThrottle.selftest.ts.
 * Run from backend/ with:
 *   yarn node src/inverterComms/setterChangeThrottle.selftest.ts
 */
import process from "process";
import {
  acChargingCurrentThrottleLimits,
  DEFAULT_SETTER_CHANGE_THROTTLE_SETTINGS,
  effectiveSetterChangeThrottleSetting,
  feedInLimitThrottleLimits,
  type SetterChangeReason,
  type SetterTargetWish,
  type SetterThrottleLimits,
  stepSetterThrottle,
  type ThrottledSetterState,
} from "./setterChangeThrottle.ts";
import { BUY_WINDOW_2026_10_27, parseBuyWindowTargets } from "../buying/buyWindowTargetFixtures.ts";

type AcChargingMode = "buy_window" | "idle_cap";

/** One evaluation's outcome, as the consumer would queue it */
type ThrottleRun<Mode extends string> = {
  state: ThrottledSetterState<Mode> | undefined;
  changes: { atMs: number; target: number; reason: SetterChangeReason }[];
};

/** useNow's tick in production: a held target goes out within one of these after its interval */
const CLOCK_TICK_MS = 2_000;
const IDLE_CAP_AMPS = 10;
const failedChecks: string[] = [];
const defaultLimits = acChargingCurrentThrottleLimits(DEFAULT_SETTER_CHANGE_THROTTLE_SETTINGS);

// ——— defaults ———
check(
  "defaults: 45 s between changes, decreases of ≥ 10 A at once",
  JSON.stringify(DEFAULT_SETTER_CHANGE_THROTTLE_SETTINGS) ===
    JSON.stringify({ min_seconds_between_setting_changes: 45, ac_charging_current_immediate_decrease_amps: 10 })
);
check(
  "GPMP gets the interval only (a lower feed-in limit sells less, it protects nothing)",
  feedInLimitThrottleLimits(DEFAULT_SETTER_CHANGE_THROTTLE_SETTINGS).immediateDecrease === undefined &&
    feedInLimitThrottleLimits(DEFAULT_SETTER_CHANGE_THROTTLE_SETTINGS).minIntervalMs === 45_000
);

// ——— the first target after a start goes out at once ———
{
  const run = newRun<AcChargingMode>();
  evaluate(run, { target: IDLE_CAP_AMPS, mode: "idle_cap" }, defaultLimits, 0);
  check("boot: the first target goes out at once", describeChanges(run) === "0:10:first_target", describeChanges(run));
}

// ——— noise-only targets: at most one write per interval ———
{
  const run = windowAt(260, 0);
  // 251↔255 every 3 s for 10 min, re-evaluated on every 2 s tick too
  for (let atMs = 1_000; atMs <= 600_000; atMs += 1_000) {
    const wish = { target: Math.floor(atMs / 3_000) % 2 ? 255 : 251, mode: "buy_window" as const };
    evaluate(run, wish, defaultLimits, atMs);
  }
  const noiseChanges = run.changes.slice(1);
  const minimumSpacingMs = Math.min(...noiseChanges.map((change, index) => change.atMs - run.changes[index]!.atMs));
  check(
    "noise 251↔255 A for 10 min: ≤ 1 write per 45 s (13 at most), all interval-elapsed, none closer than 45 s",
    noiseChanges.length <= 13 &&
      noiseChanges.every(change => change.reason === "interval_elapsed") &&
      minimumSpacingMs >= 45_000,
    `${noiseChanges.length} writes, closest ${minimumSpacingMs} ms apart`
  );
}

// ——— a large decrease goes out at once, a small one waits ———
{
  const run = windowAt(260, 0);
  evaluate(run, { target: 251, mode: "buy_window" }, defaultLimits, 5_000);
  check("a 9 A decrease 5 s after a change waits", run.state?.target === 260);
  evaluate(run, { target: 250, mode: "buy_window" }, defaultLimits, 6_000);
  check(
    "a 10 A decrease (the default margin) 6 s after a change goes out at once, as a safety decrease",
    lastChange(run) === "6000:250:large_decrease",
    lastChange(run)
  );
  evaluate(run, { target: 185, mode: "buy_window" }, defaultLimits, 7_000);
  check(
    "…and the next one 1 s later too (the 2026-10-27 19:22 load step, 256 → 185 A)",
    lastChange(run) === "7000:185:large_decrease",
    lastChange(run)
  );
  evaluate(run, { target: 265, mode: "buy_window" }, defaultLimits, 20_000);
  check("the load going away again: the increase waits for the interval", run.state?.target === 185);
  evaluate(run, { target: 265, mode: "buy_window" }, defaultLimits, 52_000);
  check("…and goes out at the first tick past it", lastChange(run) === "52000:265:interval_elapsed", lastChange(run));
}

// ——— window start and end (mode changes) are never held ———
{
  const run = newRun<AcChargingMode>();
  evaluate(run, { target: IDLE_CAP_AMPS, mode: "idle_cap" }, defaultLimits, 0);
  evaluate(run, { target: 290, mode: "buy_window" }, defaultLimits, 3_000);
  check(
    "window start 3 s after the idle cap went out: the full target at once, in one step",
    lastChange(run) === "3000:290:mode_change",
    lastChange(run)
  );
  evaluate(run, { target: 272, mode: "buy_window" }, defaultLimits, 30_000);
  check(
    "the start's own settle (290 → 272 A, 2026-10-27 18:45:27) is a large decrease",
    lastChange(run).endsWith("large_decrease")
  );
  evaluate(run, { target: IDLE_CAP_AMPS, mode: "idle_cap" }, defaultLimits, 31_000);
  check(
    "window end 1 s after a change: the step-down's idle cap at once",
    lastChange(run) === `31000:${IDLE_CAP_AMPS}:mode_change`,
    lastChange(run)
  );
  evaluate(run, { target: 261, mode: "buy_window" }, defaultLimits, 33_000);
  check("a window re-entered 2 s later: its target at once", lastChange(run) === "33000:261:mode_change");
  const gpmpRun = newRun<"solar_only" | "battery" | "selling">();
  const gpmpLimits = feedInLimitThrottleLimits(DEFAULT_SETTER_CHANGE_THROTTLE_SETTINGS);
  evaluate(gpmpRun, { target: 350, mode: "battery" }, gpmpLimits, 0);
  evaluate(gpmpRun, { target: 550, mode: "battery" }, gpmpLimits, 10_000);
  check("GPMP: an anti-peak bump 10 s after a change waits", gpmpRun.state?.target === 350);
  evaluate(gpmpRun, { target: 15_000, mode: "selling" }, gpmpLimits, 12_000);
  evaluate(gpmpRun, { target: 350, mode: "battery" }, gpmpLimits, 14_000);
  check(
    "GPMP: selling starting and ending go out at once",
    describeChanges(gpmpRun) === "0:350:first_target 12000:15000:mode_change 14000:350:mode_change",
    describeChanges(gpmpRun)
  );
  evaluate(gpmpRun, { target: 15_000, mode: "solar_only" }, gpmpLimits, 15_000);
  check("GPMP: switching to solar-only feeding goes out at once", lastChange(gpmpRun) === "15000:15000:mode_change");
  evaluate(gpmpRun, { target: 15_000, mode: "selling" }, gpmpLimits, 16_000);
  check(
    "a mode change to the same target writes nothing and keeps the interval running",
    lastChange(gpmpRun) === "15000:15000:mode_change" && gpmpRun.state?.mode === "selling"
  );
}

// ——— the knobs apply live ———
{
  const run = windowAt(260, 0);
  evaluate(run, { target: 264, mode: "buy_window" }, defaultLimits, 10_000);
  check("held at 10 s with the 45 s default", run.state?.target === 260);
  evaluate(run, { target: 264, mode: "buy_window" }, { ...defaultLimits, minIntervalMs: 10_000 }, 12_000);
  check(
    "the interval cut to 10 s: the held target goes out at the next evaluation",
    lastChange(run) === "12000:264:interval_elapsed",
    lastChange(run)
  );
  // Below the config's 15 s floor (effectiveSetterChangeThrottleSetting raises it); the step takes any interval
  evaluate(run, { target: 261, mode: "buy_window" }, { ...defaultLimits, minIntervalMs: 0 }, 12_500);
  check("an interval of 0 lets every change through", lastChange(run) === "12500:261:interval_elapsed");
  const widerMargin = acChargingCurrentThrottleLimits({
    ...DEFAULT_SETTER_CHANGE_THROTTLE_SETTINGS,
    ac_charging_current_immediate_decrease_amps: 30,
  });
  evaluate(run, { target: 241, mode: "buy_window" }, widerMargin, 13_000);
  check("margin raised to 30 A: a 20 A decrease waits", run.state?.target === 261);
  const noMargin = acChargingCurrentThrottleLimits({
    ...DEFAULT_SETTER_CHANGE_THROTTLE_SETTINGS,
    ac_charging_current_immediate_decrease_amps: 0,
  });
  evaluate(run, { target: 240, mode: "buy_window" }, noMargin, 14_000);
  check("margin 0: every decrease at once", lastChange(run) === "14000:240:large_decrease", lastChange(run));
  evaluate(run, { target: 241, mode: "buy_window" }, noMargin, 15_000);
  check("…but not an increase", run.state?.target === 240);
}

// ——— bounds: config.json is hand-editable ———
checkSetting("min_seconds_between_setting_changes", 45, { value: 45, corrected: false });
checkSetting("min_seconds_between_setting_changes", 15, { value: 15, corrected: false });
checkSetting("min_seconds_between_setting_changes", 0, { value: 15, corrected: true });
checkSetting("min_seconds_between_setting_changes", 10, { value: 15, corrected: true });
checkSetting("min_seconds_between_setting_changes", 900, { value: 300, corrected: true });
checkSetting("min_seconds_between_setting_changes", -5, { value: 45, corrected: true });
checkSetting("min_seconds_between_setting_changes", "45", { value: 45, corrected: true });
checkSetting("min_seconds_between_setting_changes", undefined, { value: 45, corrected: true });
checkSetting("min_seconds_between_setting_changes", Number.NaN, { value: 45, corrected: true });
checkSetting("ac_charging_current_immediate_decrease_amps", 31, { value: 30, corrected: true });
checkSetting("ac_charging_current_immediate_decrease_amps", 2.5, { value: 2.5, corrected: false });

// ——— replay: the 2026-10-27 buy window's logged targets ———
replayBuyWindow();

console.log(
  failedChecks.length
    ? `\n${failedChecks.length} FAILED: ${failedChecks.join(", ")}`
    : "\nAll setter throttle checks passed"
);
process.exit(failedChecks.length ? 1 : 0);

/**
 * Every logged target is evaluated when it was logged, plus a 2 s clock tick in between (useNow), with the
 * idle cap in force from long before the window and the end (0 A) as the idle cap again.
 */
function replayBuyWindow() {
  const loggedTargets = parseBuyWindowTargets(BUY_WINDOW_2026_10_27);
  const run = newRun<AcChargingMode>();
  run.state = { target: IDLE_CAP_AMPS, mode: "idle_cap", changedAtMs: -3_600_000 };
  // Code guards, not evidence from the data: stepSetterThrottle lets an elapsed interval or a decrease of
  // at least the margin through in the same evaluation, so these stay 0 on any input unless it regresses.
  // What the data shows is the summary line: the change counts and the largest overshoot.
  let heldTooLong = 0;
  let overshootAtOrAboveMargin = 0;
  let largestOvershootAmps = 0;
  for (let index = 0; index < loggedTargets.length; index++) {
    const logged = loggedTargets[index]!;
    const wish = acChargingWish(logged.amps);
    const nextLoggedAtMs = loggedTargets[index + 1]?.atMs ?? logged.atMs;
    for (let atMs = logged.atMs; atMs === logged.atMs || atMs < nextLoggedAtMs; atMs += CLOCK_TICK_MS) {
      evaluate(run, wish, defaultLimits, atMs);
      const state = run.state!;
      if (state.target !== wish.target && atMs - state.changedAtMs >= defaultLimits.minIntervalMs) heldTooLong++;
      if (state.target - wish.target >= defaultLimits.immediateDecrease!) overshootAtOrAboveMargin++;
      if (wish.mode === "buy_window") largestOvershootAmps = Math.max(largestOvershootAmps, state.target - wish.target);
    }
  }
  const windowChanges = run.changes;
  const countsByReason = Object.fromEntries(
    (["mode_change", "large_decrease", "interval_elapsed"] as const).map(reason => [
      reason,
      windowChanges.filter(change => change.reason === reason).length,
    ])
  );
  const throttledChanges = windowChanges.filter(change => change.reason === "interval_elapsed");
  const closestThrottledMs = Math.min(
    ...throttledChanges.map(change => {
      const previous = windowChanges[windowChanges.indexOf(change) - 1]!;
      return change.atMs - previous.atMs;
    })
  );
  const durationMinutes = loggedTargets[loggedTargets.length - 1]!.atMs / 60_000;
  console.log(
    `2026-10-27 replay: ${loggedTargets.length} logged targets over ${durationMinutes.toFixed(0)} min →`,
    `${windowChanges.length} MUCHGC changes (was ${BUY_WINDOW_2026_10_27.unthrottledMuchgcWrites} writes)`,
    JSON.stringify(countsByReason),
    `; the held limit at most ${largestOvershootAmps} A above the wish`
  );
  const first = windowChanges[0];
  const last = windowChanges[windowChanges.length - 1];
  check(
    "replay: the window start's 290 A goes out at once, in one step",
    first?.atMs === 0 && first.target === 290 && first.reason === "mode_change",
    JSON.stringify(first)
  );
  check(
    "replay: the window end's idle cap goes out in its own evaluation",
    last?.target === IDLE_CAP_AMPS &&
      last.reason === "mode_change" &&
      last.atMs === loggedTargets[loggedTargets.length - 1]!.atMs,
    JSON.stringify(last)
  );
  check(
    "replay: throttled changes never closer than 45 s to the previous change",
    closestThrottledMs >= 45_000,
    `${closestThrottledMs} ms`
  );
  check(
    "replay: at most one throttled change per 45 s over the window (≤ 260 in 3 h 15 min), under half the 545 writes",
    throttledChanges.length <= Math.ceil((durationMinutes * 60) / 45) &&
      windowChanges.length < BUY_WINDOW_2026_10_27.unthrottledMuchgcWrites / 2,
    `${throttledChanges.length} throttled, ${windowChanges.length} in all`
  );
  check("replay: no target is held past its interval (+ the tick)", heldTooLong === 0, `${heldTooLong} ticks`);
  check(
    "replay: the held limit never stays ≥ 10 A above the wish (every load step went out at once)",
    overshootAtOrAboveMargin === 0 && countsByReason.large_decrease! > 0,
    `${overshootAtOrAboveMargin} ticks, ${countsByReason.large_decrease} large decreases`
  );
}

function acChargingWish(loggedAmps: number): SetterTargetWish<AcChargingMode> {
  return loggedAmps ? { target: loggedAmps, mode: "buy_window" } : { target: IDLE_CAP_AMPS, mode: "idle_cap" };
}

function newRun<Mode extends string>(): ThrottleRun<Mode> {
  return { state: undefined, changes: [] };
}

/** A run inside a buy window whose target last changed to `amps` at `atMs` */
function windowAt(amps: number, atMs: number): ThrottleRun<AcChargingMode> {
  const run = newRun<AcChargingMode>();
  run.state = { target: amps, mode: "buy_window", changedAtMs: atMs };
  return run;
}

function evaluate<Mode extends string>(
  run: ThrottleRun<Mode>,
  wish: SetterTargetWish<Mode>,
  limits: SetterThrottleLimits,
  atMs: number
) {
  const { state, change } = stepSetterThrottle(run.state, wish, limits, atMs);
  if (change) run.changes.push({ atMs, target: change.next.target, reason: change.reason });
  run.state = state;
}

function describeChanges<Mode extends string>(run: ThrottleRun<Mode>): string {
  return run.changes.map(change => `${change.atMs}:${change.target}:${change.reason}`).join(" ");
}

function lastChange<Mode extends string>(run: ThrottleRun<Mode>): string {
  const change = run.changes[run.changes.length - 1];
  return change ? `${change.atMs}:${change.target}:${change.reason}` : "(none)";
}

function checkSetting(
  settingName: Parameters<typeof effectiveSetterChangeThrottleSetting>[0],
  configuredValue: unknown,
  expected: { value: number; corrected: boolean }
) {
  const { value, correction } = effectiveSetterChangeThrottleSetting(settingName, configuredValue);
  check(
    `bounds: ${settingName} = ${JSON.stringify(configuredValue) ?? "undefined"} → ${expected.value}${expected.corrected ? " (warned)" : ""}`,
    value === expected.value && (correction !== undefined) === expected.corrected,
    correction ?? ""
  );
}

function check(name: string, passed: boolean, detail = "") {
  console.log(`${passed ? "PASS" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`);
  if (!passed) failedChecks.push(name);
}
