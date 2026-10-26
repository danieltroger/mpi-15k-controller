/**
 * The live usb_parameter_setting.quiet_gap_after_write_ms knob (#52) on its way into the
 * scheduler: a value the scheduler can't use is corrected loudly, and a change logs once, so an
 * experiment's switch-over is visible in the log right where the writes it affects start.
 */
import { logLog, warnLog } from "../utilities/logging.ts";
import { withQuietGapAfterWrite, type SchedulerState } from "./schedulerCore.ts";
import { effectiveQuietGapMs } from "./schedulerTiming.ts";

/**
 * Called on every change of the configured value. A running confirm phase keeps its gap and
 * strategy, so the new value applies from the first write after it.
 */
export function schedulerWithQuietGapSetting(scheduler: SchedulerState, configuredMs: number): SchedulerState {
  const quietGapMs = quietGapFromConfig(configuredMs);
  const previousMs = scheduler.timing.quietGapAfterWriteMs;
  if (quietGapMs === previousMs) return scheduler;
  logLog(
    "Inverter quiet gap after write:",
    previousMs,
    "→",
    quietGapMs,
    "ms —",
    quietGapMs > 0 ? "radio silence after each write" : "GS/PS polling continues through writes",
    "(applies from the first write after any running confirm phase)",
    ...(scheduler.starvationFallback ? ["— ends the starvation fallback"] : [])
  );
  return withQuietGapAfterWrite(scheduler, quietGapMs);
}

export function quietGapFromConfig(configuredMs: number): number {
  const { quietGapMs, correction } = effectiveQuietGapMs(configuredMs);
  if (correction) warnLog("usb_parameter_setting.quiet_gap_after_write_ms:", correction);
  return quietGapMs;
}
