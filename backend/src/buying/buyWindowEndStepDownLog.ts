import { errorLog, logLog, warnLog } from "../utilities/logging.ts";
import type { LimitEvidence, StepDownEvent } from "./buyWindowEndStepDown.ts";
import { ALTERNATE_CAP_AMPS, IDLE_AC_CHARGING_LIMIT_AMPS, SETTLED_FOR_MS } from "./buyWindowEndEvidence.ts";
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
        "MUCHGC0100 once (the session sends it no sooner than 60 s after the last one)"
      );
    case "ambiguous_limit_readback":
      return logLog(
        prefix,
        `BATS shows ${formatAmps(event.limitReadbackAmps)} ${formatSeconds(event.afterMs)} in, but that can't tell`,
        `whether the unproven ${event.unprovenHigherLimitsAmps.map(formatAmps).join(", ")} write(s) landed or are`,
        `still to come — sending the cap as ${ALTERNATE_CAP_AMPS} A (MUCHGC0090), which BATS can only show once`,
        "every earlier write has landed"
      );
    case "readback_requested":
      return logLog(
        prefix,
        `the hall has shown the cap in effect for ${formatSeconds(event.hallSettledForMs)}, but BATS doesn't prove it`,
        `(${describeLimitReadback(event.limitReadbackAmps, event.limitEvidence)}) and the session won't read it again on`,
        `its own — asking for a settings readback (request ${event.attempt}, ${formatSeconds(event.afterMs)} in)`
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
        `${describeLimitReadback(event.limitReadback?.amps, event.limitEvidence)}. Holding EDB0 back up to`,
        `${formatSeconds(event.extensionMs)} more and sending the cap again as ${ALTERNATE_CAP_AMPS} A (MUCHGC0090,`,
        "which a stale readback can't satisfy): EDB0 now would stop full current in one step"
      );
    case "timed_out": {
      const summary = [
        prefix,
        `the ${IDLE_AC_CHARGING_LIMIT_AMPS} A cap wasn't proven within ${formatSeconds(event.afterMs)} — sending EDB0 anyway.`,
        `${describeLimitReadback(event.limitReadback?.amps, event.limitEvidence)};`,
        `hall ${formatAmps(event.hallBatteryAmps)} (allowed ≤ ${formatAmps(event.allowedHallAmps)})`,
      ];
      if (event.hallAboveAllowance) {
        return errorLog(...summary, "— EDB0 goes out with the cap not in effect (one-step stop at full current)");
      }
      const hallShowsCap = event.hallSettledForMs !== undefined && event.hallSettledForMs >= SETTLED_FOR_MS;
      if (hallShowsCap && !event.higherLimitMayLand) {
        return warnLog(
          ...summary,
          `— the hall has shown the cap in effect for ${formatSeconds(event.hallSettledForMs ?? 0)} and no higher-limit`,
          "write can still land: BATS just wasn't read again after the cap committed"
        );
      }
      return warnLog(...summary);
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

function describeLimitReadback(readbackAmps: number | undefined, evidence: LimitEvidence): string {
  switch (evidence) {
    case "none":
      return "No BATS limit readback";
    case "shows_higher_limit":
      return `BATS still shows ${formatAmps(readbackAmps)}`;
    case "higher_limit_unproven":
      return `BATS shows ${formatAmps(readbackAmps)}, but a higher-limit write no readback has proven landed may still commit`;
    case "shows_cap":
      return `BATS shows ${formatAmps(readbackAmps)}, but the hall never stayed within the allowance for long enough to prove it in effect`;
  }
}

function formatAmps(amps: number | undefined): string {
  return amps === undefined ? "unknown" : `${amps.toFixed(1)} A`;
}

function formatSeconds(milliseconds: number): string {
  return `${(milliseconds / 1000).toFixed(1)} s`;
}
