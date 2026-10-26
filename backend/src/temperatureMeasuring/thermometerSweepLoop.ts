import { type Accessor, createEffect, on, onCleanup, untrack } from "solid-js";
import type { SweepLogger, ThermometerSweepResult } from "./thermometerSweep.ts";
import { THERMOMETER_SWEEP_SETTING_BOUNDS } from "./thermometerSweepSettings.ts";

/** The timers the loop waits on: setTimeout in production, a simulated clock in the selftest */
export type SweepClock = {
  /**
   * Monotonic. The loop only measures durations, and every wake-up checks whether the next sweep is due: on the
   * wall clock, a step back would hold the sweeps off for the length of the step (#73 review), and nothing would
   * page meanwhile. Readings keep their wall-clock timestamps (nodeSysfsAccess.nowMs).
   */
  nowMs: () => number;
  /** Calls `onFire` after `delayMs`, on a later timer turn even at 0 (never synchronously); returns a cancel */
  setTimer: (delayMs: number, onFire: () => void) => () => void;
};

export type ThermometerSweepLoopOptions = {
  /** temperature_saving.thermometer_sweep_interval_seconds, live and corrected (useThermometerSweepSettings) */
  intervalSeconds: Accessor<number>;
  sweep: () => Promise<ThermometerSweepResult>;
  /** Not called for a sweep that ends after the loop was stopped */
  publish: (sweep: ThermometerSweepResult) => void;
  clock: SweepClock;
  logger: SweepLogger;
};

export const SYSTEM_SWEEP_CLOCK: SweepClock = {
  nowMs: () => performance.now(),
  setTimer: (delayMs, onFire) => {
    const timer = setTimeout(onFire, delayMs);
    return () => clearTimeout(timer);
  },
};

type SweepLoopControl = {
  stopped: boolean;
  /** Set while the loop waits for the next sweep: ends that wait now, so it's re-measured against the interval */
  endWaitEarly: (() => void) | undefined;
};

type SweepLoopContext = ThermometerSweepLoopOptions & { control: SweepLoopControl };

/**
 * A sweep that read no probe at all (the bus gone, no probe configured, a sweep that threw) is followed by the
 * next only after at least the default interval. Back to back, such sweeps can finish in milliseconds and would
 * log every probe's failure many times a second.
 */
const EMPTY_SWEEP_BACKOFF_MS = THERMOMETER_SWEEP_SETTING_BOUNDS.thermometer_sweep_interval_seconds.defaultValue * 1000;

/**
 * Sweeps the thermometers every temperature_saving.thermometer_sweep_interval_seconds, measured start to start,
 * until the calling owner is disposed. Sweeps never overlap: one async loop awaits each sweep before it starts
 * the next, so a sweep that runs longer than the interval (always the case at 0) is followed by the next one as
 * soon as it ends. The interval is live: a change re-measures the running wait at once, so going from 60 s to
 * 5 s doesn't sit out the old wait.
 */
export function startThermometerSweepLoop(loopOptions: ThermometerSweepLoopOptions) {
  const control: SweepLoopControl = { stopped: false, endWaitEarly: undefined };
  createEffect(on(loopOptions.intervalSeconds, () => control.endWaitEarly?.(), { defer: true }));
  onCleanup(() => {
    control.stopped = true;
    control.endWaitEarly?.();
  });

  loopOptions.logger.log(`Starting thermometer sweeps ${describeSweepCadence(untrack(loopOptions.intervalSeconds))}`);
  // The first sweep starts synchronously, inside whichever computation called this: untrack keeps its reads
  // from subscribing that computation
  untrack(() => void runSweepLoop({ ...loopOptions, control }));
}

async function runSweepLoop(context: SweepLoopContext) {
  while (!context.control.stopped) {
    const sweepStartedAtMs = context.clock.nowMs();
    const probesRead = await sweepAndPublish(context);
    await waitForNextSweep(context, sweepStartedAtMs, probesRead);
  }
  context.logger.log("Stopped thermometer sweeps");
}

/** Resolves to the number of probes read; never rejects, so the loop can't die of one bad sweep */
async function sweepAndPublish({ sweep, publish, control, logger }: SweepLoopContext): Promise<number> {
  try {
    const result = await sweep();
    if (!control.stopped) publish(result);
    return result.readings.length;
  } catch (error) {
    logger.error(
      `Thermometer sweep or publishing its readings threw, although sysfs failures never throw. Sweeping again in ${EMPTY_SWEEP_BACKOFF_MS / 1000} s at the earliest`,
      error
    );
    return 0;
  }
}

/**
 * Waits until the next sweep is due, re-measuring whenever the interval changes. Always takes at least one
 * timer turn, even at 0 or behind a sweep that overran: a sweep can settle on promise callbacks alone, and back
 * to back without a timer turn in between, the loop would never let a socket, timer or the inverter session run.
 */
async function waitForNextSweep(context: SweepLoopContext, sweepStartedAtMs: number, probesRead: number) {
  if (context.control.stopped) return;
  do {
    const remainingMs = nextSweepDueAtMs(context, sweepStartedAtMs, probesRead) - context.clock.nowMs();
    await sleepUnlessWoken(context, Math.max(0, remainingMs));
  } while (!context.control.stopped && context.clock.nowMs() < nextSweepDueAtMs(context, sweepStartedAtMs, probesRead));
}

function nextSweepDueAtMs({ intervalSeconds }: SweepLoopContext, sweepStartedAtMs: number, probesRead: number) {
  const intervalMs = untrack(intervalSeconds) * 1000;
  return sweepStartedAtMs + (probesRead > 0 ? intervalMs : Math.max(intervalMs, EMPTY_SWEEP_BACKOFF_MS));
}

function sleepUnlessWoken({ control, clock }: SweepLoopContext, delayMs: number): Promise<void> {
  return new Promise(resolve => {
    const cancelTimer = clock.setTimer(delayMs, () => {
      control.endWaitEarly = undefined;
      resolve();
    });
    control.endWaitEarly = () => {
      cancelTimer();
      control.endWaitEarly = undefined;
      resolve();
    };
  });
}

function describeSweepCadence(intervalSeconds: number) {
  return intervalSeconds ? `every ${intervalSeconds} s` : "back to back";
}
