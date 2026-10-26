import { errorLog, logLog, warnLog } from "../utilities/logging.ts";
import {
  type AcChargingLimitReadback,
  IDLE_AC_CHARGING_LIMIT_AMPS,
  type LimitEvidence,
  type StepDownEvent,
} from "./buyWindowEndStepDown.ts";
import { MAX_EDB0_RETRIES } from "./buyWindowEndRelease.ts";

/** One log line per step-down transition, with its timing — the record to judge the step-down by */
export function logStepDownEvent(event: StepDownEvent): void {
  const prefix = "Buy-window end step-down:";
  switch (event.kind) {
    case "started":
      return logLog(
        prefix,
        `AC charging may be enabled with no buy window wanting it — capping it at ${IDLE_AC_CHARGING_LIMIT_AMPS} A first`,
        `and holding EDB0 back until that has taken effect (limit readback ${formatAmps(event.limitReadbackAmps)},`,
        `hall ${formatAmps(event.hallBatteryAmps)})`
      );
    case "limit_confirmed":
      return logLog(
        prefix,
        `BATS shows the AC charging limit at ${formatAmps(event.limitAmps)} ${formatSeconds(event.afterMs)} in;`,
        `hall ${formatAmps(event.hallBatteryAmps)} (allowed ≤ ${formatAmps(event.allowedHallAmps)})`
      );
    case "limit_reasserted":
      return warnLog(
        prefix,
        `BATS still shows ${formatAmps(event.limitReadbackAmps)} ${formatSeconds(event.afterMs)} in — re-queueing`,
        `MUCHGC0100 (the session sends it no sooner than 60 s after the last one)`
      );
    case "released":
      return logLog(
        prefix,
        `hall ${formatAmps(event.hallBatteryAmps)} has stayed ≤ ${formatAmps(event.allowedHallAmps)} for`,
        `${formatSeconds(event.hallSettledForMs)} and BATS showed the cap ${formatSeconds(event.limitConfirmedAfterMs)}`,
        `in — releasing EDB0 ${formatSeconds(event.afterMs)} after the step-down started`
      );
    case "released_without_hall":
      return warnLog(
        prefix,
        "no fresh hall sensor reading — releasing EDB0 on the BATS readback alone (cap shown",
        `${formatSeconds(event.limitConfirmedAfterMs)} in), ${formatSeconds(event.afterMs)} after the step-down started`
      );
    case "hold_extended":
      // The F14 setup: the cap is demonstrably not in effect when EDB0 would have gone out
      return errorLog(
        prefix,
        `after ${formatSeconds(event.afterMs)} the hall still shows ${formatAmps(event.hallBatteryAmps)}`,
        `(allowed ≤ ${formatAmps(event.allowedHallAmps)}) — the ${IDLE_AC_CHARGING_LIMIT_AMPS} A cap is not in effect.`,
        `${describeLimitReadback(event.limitReadback, event.limitEvidence)}. Holding EDB0 back up to`,
        `${formatSeconds(event.extensionMs)} more and re-asserting the cap: EDB0 now would stop full current in one step`
      );
    case "timed_out": {
      const summary = [
        prefix,
        `the ${IDLE_AC_CHARGING_LIMIT_AMPS} A cap wasn't proven within ${formatSeconds(event.afterMs)} — sending EDB0 anyway.`,
        `${describeLimitReadback(event.limitReadback, event.limitEvidence)};`,
        `hall ${formatAmps(event.hallBatteryAmps)} (allowed ≤ ${formatAmps(event.allowedHallAmps)})`,
      ];
      if (!event.hallAboveAllowance) return warnLog(...summary);
      return errorLog(...summary, "— EDB0 goes out with the cap not in effect (one-step stop at full current)");
    }
    case "cancelled":
      return logLog(prefix, `cancelled ${formatSeconds(event.afterMs)} in: ${event.reason}`);
    case "ac_charging_disabled_confirmed":
      return logLog(
        prefix,
        `HECS shows AC charging disabled ${formatSeconds(event.afterReleaseMs)} after EDB0 was released`,
        `(${formatSeconds(event.afterMs)} after the step-down started)`
      );
    case "release_superseded":
      return logLog(
        prefix,
        `grid charging wanted again ${formatSeconds(event.afterReleaseMs)} after EDB0 was released,`,
        "before HECS showed it applied"
      );
    case "edb0_retry":
      return warnLog(
        prefix,
        `HECS still shows AC charging enabled ${formatSeconds(event.afterReleaseMs)} after EDB0 was released —`,
        `re-queueing EDB0 (retry ${event.attempt} of ${MAX_EDB0_RETRIES})`
      );
    case "edb0_retries_exhausted":
      return errorLog(
        prefix,
        `EDB0 still not applied ${formatSeconds(event.afterReleaseMs)} after the release (${event.attempts} retries):`,
        `AC charging stays enabled until the next buy window, at the last read-back limit of`,
        formatAmps(event.lastLimitReadbackAmps)
      );
  }
}

function describeLimitReadback(readback: AcChargingLimitReadback | undefined, evidence: LimitEvidence): string {
  switch (evidence) {
    case "none":
      return "No BATS limit readback";
    case "shows_higher_limit":
      return `BATS still shows ${formatAmps(readback?.amps)}`;
    case "predates_last_higher_limit_write":
      return `BATS shows ${formatAmps(readback?.amps)}, but read before the last higher-limit write went out`;
    case "shows_cap":
      return `BATS shows ${formatAmps(readback?.amps)}, but the hall never settled for long enough past the last higher-limit write's commit margin to prove it`;
  }
}

function formatAmps(amps: number | undefined): string {
  return amps === undefined ? "unknown" : `${amps.toFixed(1)} A`;
}

function formatSeconds(milliseconds: number): string {
  return `${(milliseconds / 1000).toFixed(1)} s`;
}
