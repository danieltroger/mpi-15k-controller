/**
 * Self-test of the thermometer sweep loop, run inside a createRoot against a config signal (through
 * useThermometerSweepSettings, as in production) and a simulated clock: start-to-start pacing, a live change of
 * temperature_saving.thermometer_sweep_interval_seconds re-measuring the running wait, 0 and intervals shorter
 * than a sweep running back to back without ever overlapping, a timer turn between sweeps even when a sweep
 * settles at once, the back-off after an empty or throwing sweep, corrected values, and stopping. The settings'
 * bounds and warnings are in thermometerSweepSettings.selftest.ts. Run from backend/ with:
 *   yarn node src/temperatureMeasuring/thermometerSweepLoop.selftest.ts
 */
import process from "process";
import { createRoot, createSignal, type Setter } from "solid-js";
import { default_config } from "../config/config.ts";
import type { Config } from "../config/config.types.ts";
import type { TemperatureReadingBroadcast } from "../sharedTypes.ts";
import type { SweepLogger, ThermometerSweepResult } from "./thermometerSweep.ts";
import { type SweepClock, startThermometerSweepLoop } from "./thermometerSweepLoop.ts";
import { useThermometerSweepSettings } from "./useThermometerSweepSettings.ts";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.error(`FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

type LoggedLine = { level: "log" | "warn" | "error"; text: string };

type FakeTimer = { fireAtMs: number; onFire: () => void; cancelled: boolean };

type FakeTimeline = {
  nowMs: number;
  pendingTimers: FakeTimer[];
  /** Timers the loop itself set, i.e. its waits between sweeps */
  loopTimersSet: number;
};

/** What the next fake sweeps do; changeable mid-test */
type FakeSweepBehaviour = { durationMs: number; probesRead: number; throws: boolean };

type LoopHarness = {
  timeline: FakeTimeline;
  sweepBehaviour: FakeSweepBehaviour;
  sweepStartsMs: number[];
  sweepsInFlight: number;
  maxSweepsInFlight: number;
  publishedSweeps: number;
  lines: LoggedLine[];
  setConfig: Setter<Config>;
  stop: () => void;
};

const TYPICAL_BULK_SWEEP_MS = 1150;

// ——— 10 s start to start, then live changes re-measure the running wait ———
{
  const harness = startHarness(10, { durationMs: TYPICAL_BULK_SWEEP_MS, probesRead: 14, throws: false });
  check("start: logged with its cadence", harness.lines[0]?.text, "Starting thermometer sweeps every 10 s");
  await advanceTo(harness.timeline, 25_000);
  check("10 s: measured start to start", harness.sweepStartsMs, [0, 10_000, 20_000]);
  check("10 s: every sweep published", harness.publishedSweeps, 3);

  // At 25 s, waiting for the sweep due at 30 s
  setConfiguredInterval(harness, 30);
  await advanceTo(harness.timeline, 100_000);
  check(
    "10 → 30 s mid-wait: the running wait stretches to 30 s after its sweep's start",
    harness.sweepStartsMs.slice(3),
    [50_000, 80_000]
  );
  check(
    "10 → 30 s: the change is logged",
    harness.lines.some(
      line => line.text === "temperature_saving.thermometer_sweep_interval_seconds: 10 → 30 s, from the next sweep"
    ),
    true
  );

  // At 100 s the next sweep is due at 110 s; at 300 s it moves to 380 s, and back down to 5 s mid-wait
  setConfiguredInterval(harness, 300);
  await advanceTo(harness.timeline, 120_000);
  setConfiguredInterval(harness, 5);
  await advanceTo(harness.timeline, 131_000);
  check(
    "300 → 5 s mid-wait: sweeps at once instead of sitting out the 300 s wait, then every 5 s",
    harness.sweepStartsMs.slice(5),
    [120_000, 125_000, 130_000]
  );
  check("live changes: never two sweeps at once", harness.maxSweepsInFlight, 1);
  check("live changes: no warnings for valid values", warnings(harness), []);
  harness.stop();
}

// ——— 0: back to back, each sweep starting as the previous one ends, with a timer turn in between ———
{
  const harness = startHarness(0, { durationMs: TYPICAL_BULK_SWEEP_MS, probesRead: 14, throws: false });
  check("0: logged as back to back", harness.lines[0]?.text, "Starting thermometer sweeps back to back");
  await advanceTo(harness.timeline, 5000);
  check("0: each sweep starts as the previous one ends", harness.sweepStartsMs, [0, 1150, 2300, 3450, 4600]);
  check("0: never two sweeps at once", harness.maxSweepsInFlight, 1);
  check(
    "0: one timer turn after every finished sweep",
    harness.timeline.loopTimersSet,
    harness.sweepStartsMs.length - 1
  );
  harness.stop();
}

// ——— intervals shorter than a sweep: back to back; longer than a sweep: start to start ———
{
  const harness = startHarness(1, { durationMs: TYPICAL_BULK_SWEEP_MS, probesRead: 14, throws: false });
  await advanceTo(harness.timeline, 3000);
  check("1 s with 1.15 s sweeps: back to back", harness.sweepStartsMs, [0, 1150, 2300]);
  check("1 s with 1.15 s sweeps: never two sweeps at once", harness.maxSweepsInFlight, 1);
  harness.stop();

  const quickSweeps = startHarness(1, { durationMs: 400, probesRead: 14, throws: false });
  await advanceTo(quickSweeps.timeline, 2500);
  check("1 s with 0.4 s sweeps: start to start", quickSweeps.sweepStartsMs, [0, 1000, 2000]);
  quickSweeps.stop();
}

// ——— a sweep that overruns the interval (the ~11 s w1_slave fallback, say) is followed straight away ———
{
  const harness = startHarness(10, { durationMs: 15_000, probesRead: 14, throws: false });
  await advanceTo(harness.timeline, 40_000);
  check("overrun: the next sweep starts as the slow one ends", harness.sweepStartsMs, [0, 15_000, 30_000]);
  check("overrun: never two sweeps at once", harness.maxSweepsInFlight, 1);
  harness.stop();
}

// ——— a sweep that settles at once (promise callbacks only) can't chain sweeps without a timer turn ———
{
  const harness = startHarness(0, { durationMs: 0, probesRead: 14, throws: false });
  await settle();
  await settle();
  check(
    "instant sweep at 0: one sweep, then the loop waits on a timer",
    [harness.sweepStartsMs.length, harness.timeline.loopTimersSet],
    [1, 1]
  );
  await fireNextTimer(harness.timeline);
  await fireNextTimer(harness.timeline);
  check(
    "instant sweep at 0: one more sweep per timer turn",
    [harness.sweepStartsMs.length, harness.timeline.loopTimersSet],
    [3, 3]
  );
  harness.stop();
}

// ——— a sweep that reads nothing, or throws, backs off to the default interval even at 0 ———
{
  const harness = startHarness(0, { durationMs: TYPICAL_BULK_SWEEP_MS, probesRead: 0, throws: false });
  await advanceTo(harness.timeline, 25_000);
  check("empty sweeps at 0: one every 10 s", harness.sweepStartsMs, [0, 10_000, 20_000]);
  harness.sweepBehaviour.probesRead = 14;
  await advanceTo(harness.timeline, 33_000);
  check(
    "empty sweeps at 0: back to back again once a sweep reads something",
    harness.sweepStartsMs.slice(3),
    [30_000, 31_150, 32_300]
  );

  harness.sweepBehaviour.throws = true;
  await advanceTo(harness.timeline, 50_000);
  check(
    "a throwing sweep: logged as an error, the loop survives and backs off 10 s",
    [errors(harness).length, harness.sweepStartsMs.slice(6)],
    [2, [33_450, 43_450]]
  );
  check("a throwing sweep: its error is in the log line", errors(harness)[0]?.includes("injected sweep failure"), true);
  harness.stop();
}

// ——— bad values reach the loop corrected: a fallback to 10 s, a clamp to 300 s, each warned once ———
{
  const harness = startHarness("ten", { durationMs: TYPICAL_BULK_SWEEP_MS, probesRead: 14, throws: false });
  await advanceTo(harness.timeline, 15_000);
  check("bad value: falls back to 10 s", harness.sweepStartsMs, [0, 10_000]);
  harness.setConfig(previous => ({ ...previous, mqtt_host: "192.168.0.4" }));
  await advanceTo(harness.timeline, 16_000);
  check("bad value: warned once, an unrelated config write doesn't repeat it", warnings(harness), [
    'temperature_saving.thermometer_sweep_interval_seconds: "ten" is not a non-negative number of seconds, using the default 10 s',
  ]);
  setConfiguredInterval(harness, 1000);
  await advanceTo(harness.timeline, 700_000);
  check(
    "too long: clamped to 300 s, warned once",
    [harness.sweepStartsMs.slice(2), warnings(harness).length],
    [[310_000, 610_000], 2]
  );
  harness.stop();
}

// ——— stopping: mid-wait ends the wait; mid-sweep drops that sweep's readings ———
{
  const harness = startHarness(300, { durationMs: TYPICAL_BULK_SWEEP_MS, probesRead: 14, throws: false });
  await advanceTo(harness.timeline, 15_000);
  harness.stop();
  await settle();
  check(
    "stopped mid-wait: logged, the 300 s wait ended rather than left pending",
    [harness.lines.at(-1)?.text, liveTimers(harness.timeline).length],
    ["Stopped thermometer sweeps", 0]
  );
  await advanceTo(harness.timeline, 700_000);
  check("stopped mid-wait: no sweep after the stop", harness.sweepStartsMs, [0]);

  const slowSweep = startHarness(10, { durationMs: 5000, probesRead: 14, throws: false });
  await advanceTo(slowSweep.timeline, 2000);
  slowSweep.stop();
  await advanceTo(slowSweep.timeline, 60_000);
  check(
    "stopped mid-sweep: that sweep finishes but isn't published, and none follows",
    [slowSweep.sweepStartsMs, slowSweep.publishedSweeps, slowSweep.lines.at(-1)?.text],
    [[0], 0, "Stopped thermometer sweeps"]
  );
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall thermometer sweep loop checks passed");

function startHarness(configuredIntervalSeconds: unknown, sweepBehaviour: FakeSweepBehaviour): LoopHarness {
  const timeline: FakeTimeline = { nowMs: 0, pendingTimers: [], loopTimersSet: 0 };
  return createRoot(dispose => {
    const [config, setConfig] = createSignal<Config>(withSweepInterval(default_config, configuredIntervalSeconds));
    const harness: LoopHarness = {
      timeline,
      sweepBehaviour: { ...sweepBehaviour },
      sweepStartsMs: [],
      sweepsInFlight: 0,
      maxSweepsInFlight: 0,
      publishedSweeps: 0,
      lines: [],
      setConfig,
      stop: dispose,
    };
    const logger = capturingLogger(harness.lines);
    startThermometerSweepLoop({
      intervalSeconds: useThermometerSweepSettings(config, logger).thermometer_sweep_interval_seconds,
      sweep: () => fakeSweep(harness),
      publish: () => harness.publishedSweeps++,
      clock: loopClock(timeline),
      logger,
    });
    return harness;
  });
}

function setConfiguredInterval(harness: LoopHarness, configuredIntervalSeconds: unknown) {
  harness.setConfig(previous => withSweepInterval(previous, configuredIntervalSeconds));
}

function withSweepInterval(config: Config, configuredIntervalSeconds: unknown): Config {
  return {
    ...config,
    temperature_saving: {
      ...config.temperature_saving,
      // The cast is the point: config.json is hand-editable, so the loop must cope with anything here
      thermometer_sweep_interval_seconds: configuredIntervalSeconds as number,
    },
  };
}

async function fakeSweep(harness: LoopHarness): Promise<ThermometerSweepResult> {
  const { durationMs, probesRead, throws } = harness.sweepBehaviour;
  harness.sweepStartsMs.push(harness.timeline.nowMs);
  // Sweeps chained without a timer turn would spin in promise callbacks and hang this test: stop the loop
  // instead, so the checks fail
  if (harness.sweepStartsMs.length - harness.timeline.loopTimersSet > 100) harness.stop();
  harness.sweepsInFlight++;
  harness.maxSweepsInFlight = Math.max(harness.maxSweepsInFlight, harness.sweepsInFlight);
  if (durationMs) await new Promise<void>(resolve => scheduleFakeTimer(harness.timeline, durationMs, resolve));
  harness.sweepsInFlight--;
  if (throws) throw new Error("injected sweep failure");
  const readings = Array.from({ length: probesRead }, (_slot, probeIndex) =>
    fakeReading(probeIndex, harness.timeline.nowMs)
  );
  return { method: "bulk", readings, durationMs };
}

function fakeReading(probeIndex: number, readAtMs: number): TemperatureReadingBroadcast {
  return { value: 21, time: readAtMs, thermometer_device_id: `28-${probeIndex}`, label: `probe_${probeIndex}` };
}

function loopClock(timeline: FakeTimeline): SweepClock {
  return {
    nowMs: () => timeline.nowMs,
    setTimer: (delayMs, onFire) => {
      timeline.loopTimersSet++;
      return scheduleFakeTimer(timeline, delayMs, onFire);
    },
  };
}

function scheduleFakeTimer(timeline: FakeTimeline, delayMs: number, onFire: () => void) {
  const timer: FakeTimer = { fireAtMs: timeline.nowMs + delayMs, onFire, cancelled: false };
  timeline.pendingTimers.push(timer);
  return () => {
    timer.cancelled = true;
  };
}

/** Fires every timer due up to `targetMs` in time order (ties in the order they were set), then sets the clock there */
async function advanceTo(timeline: FakeTimeline, targetMs: number) {
  await settle();
  for (let firedTimers = 0; ; firedTimers++) {
    // A loop that keeps setting timers at the current instant would hang the test instead of failing it
    if (firedTimers > 100_000) throw new Error(`Timers keep firing at ${timeline.nowMs} ms without time passing`);
    const dueTimer = liveTimers(timeline).find(timer => timer.fireAtMs <= targetMs && isEarliest(timeline, timer));
    if (!dueTimer) break;
    await fireTimer(timeline, dueTimer);
  }
  timeline.nowMs = targetMs;
  await settle();
}

async function fireNextTimer(timeline: FakeTimeline) {
  const nextTimer = liveTimers(timeline).find(timer => isEarliest(timeline, timer));
  if (!nextTimer) throw new Error("No timer pending");
  await fireTimer(timeline, nextTimer);
}

async function fireTimer(timeline: FakeTimeline, timer: FakeTimer) {
  timeline.pendingTimers.splice(timeline.pendingTimers.indexOf(timer), 1);
  timeline.nowMs = Math.max(timeline.nowMs, timer.fireAtMs);
  timer.onFire();
  await settle();
}

function liveTimers(timeline: FakeTimeline) {
  return timeline.pendingTimers.filter(timer => !timer.cancelled);
}

function isEarliest(timeline: FakeTimeline, candidate: FakeTimer) {
  return liveTimers(timeline).every(timer => timer.fireAtMs >= candidate.fireAtMs);
}

/** Lets every pending promise callback run: setImmediate only fires once the microtask queue is empty */
function settle() {
  return new Promise<void>(resolve => setImmediate(resolve));
}

function capturingLogger(lines: LoggedLine[]): SweepLogger {
  return {
    log: (...details) => lines.push({ level: "log", text: details.map(String).join(" ") }),
    warn: (...details) => lines.push({ level: "warn", text: details.map(String).join(" ") }),
    error: (...details) => lines.push({ level: "error", text: details.map(String).join(" ") }),
  };
}

function warnings(harness: LoopHarness) {
  return harness.lines.filter(line => line.level === "warn").map(line => line.text);
}

function errors(harness: LoopHarness) {
  return harness.lines.filter(line => line.level === "error").map(line => line.text);
}
