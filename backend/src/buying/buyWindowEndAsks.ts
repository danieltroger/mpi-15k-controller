/**
 * What the buy-window end step-down asks of the session while it waits for the cap's proof, pure and
 * bounded: MUCHGC0100 re-queued once, the alternate cap once to settle an ambiguous readback, and a fresh
 * settings readback while the hall shows the cap in effect but no readback proves it. Each returns the
 * step-down's new count; the reactive graph acts on every increase (buyingSetterWiring.ts). The state
 * machine: buyWindowEndStepDown.ts.
 */
import {
  CONFIRM_RECHECK_INTERVAL_MS,
  FIRST_CONFIRM_AFTER_WRITE_MS,
  SETTINGS_READBACK_REQUEST_LIFETIME_MS,
} from "../inverterComms/schedulerTiming.ts";
import { ambiguousHigherLimitsAmps, IDLE_AC_CHARGING_LIMIT_AMPS, SETTLED_FOR_MS } from "./buyWindowEndEvidence.ts";
import type {
  AcChargingLimitReadback,
  BuyWindowEndInputs,
  LimitEvidence,
  StepDownEvent,
  SteppingDown,
} from "./buyWindowEndStepDown.types.ts";

/**
 * MUCHGC0100 is re-queued once when a BATS readback during the step-down still shows a higher limit:
 * #48 leaves re-sending a write whose confirm gave up to its owner. Bounded, so that a cap the inverter
 * never applies costs a send or two, never a loop.
 */
export const MAX_LIMIT_REASSERTIONS = 1;
/**
 * A settings readback is asked for again this often while the hall shows the cap but no readback proves
 * it. A pending write is re-read every 4 s (behind ≤ 2 s of poll round), so a readback this old
 * means none is coming; each request costs one GPMP + HECS + BATS round (~1.4 s on the wire), at most a
 * dozen before the timeout.
 */
export const READBACK_REQUEST_INTERVAL_MS = 10_000;
/** The longest poll round (GS + PS + the settings queries) a due confirm waits behind */
const POLL_ROUND_ALLOWANCE_MS = 2_000;
/**
 * A write's own confirm reads BATS 9 s after it, behind ≤ 2 s of poll round, or one 4 s re-check later
 * if that answer is lost; here with a request interval's margin: 25 s, as #70 validated it. Or never:
 * a NAKed or unanswered write arms no check, and MUCHGC's confirm refreshes nothing else (#70's review:
 * a NAKed MUCHGC0090 left the step-down to time out blind).
 */
export const OWN_CONFIRM_DUE_WITHIN_MS =
  FIRST_CONFIRM_AFTER_WRITE_MS + POLL_ROUND_ALLOWANCE_MS + CONFIRM_RECHECK_INTERVAL_MS + READBACK_REQUEST_INTERVAL_MS;

/** A new BATS readback during the step-down that still shows a higher limit re-asserts the cap (bounded) */
export function nextLimitReassertions(
  progress: SteppingDown,
  readback: AcChargingLimitReadback | undefined,
  nowMs: number,
  events: StepDownEvent[]
): number {
  if (!isNewReadback(progress, readback) || readback.amps <= IDLE_AC_CHARGING_LIMIT_AMPS) {
    return progress.limitReassertions;
  }
  // Not during an extension: a queued MUCHGC0100 would replace the alternate cap in the session queue. Nor
  // on the deadline's own step, which extends (sending the alternate cap) or sends EDB0 — `extended` is
  // still false there, and both caps would be queued in one tick with MUCHGC0100 last
  if (progress.extended || nowMs >= progress.deadlineMs || progress.limitReassertions >= MAX_LIMIT_REASSERTIONS) {
    return progress.limitReassertions;
  }
  events.push({ kind: "limit_reasserted", afterMs: nowMs - progress.startedAtMs, limitReadbackAmps: readback.amps });
  return progress.limitReassertions + 1;
}

/**
 * A new readback that can't tell whether a higher write landed (ambiguousHigherLimitsAmps) asks for the
 * alternate cap, once — not again after the extension asked for it either. Nor on the deadline's own step,
 * which extends (asking for it) or sends EDB0.
 */
export function nextAlternateCapRequests(
  progress: SteppingDown,
  inputs: Pick<BuyWindowEndInputs, "limitReadback" | "unprovenLimitWrites">,
  nowMs: number,
  events: StepDownEvent[]
): number {
  const readback = inputs.limitReadback;
  if (!isNewReadback(progress, readback) || progress.alternateCapRequests > 0 || nowMs >= progress.deadlineMs) {
    return progress.alternateCapRequests;
  }
  const unprovenHigherLimitsAmps = ambiguousHigherLimitsAmps(readback, inputs.unprovenLimitWrites);
  if (!unprovenHigherLimitsAmps.length) return progress.alternateCapRequests;
  events.push({
    kind: "ambiguous_limit_readback",
    afterMs: nowMs - progress.startedAtMs,
    limitReadbackAmps: readback.amps,
    unprovenHigherLimitsAmps,
  });
  return progress.alternateCapRequests + 1;
}

/**
 * The hall has shown the cap in effect for the settle time but no readback proves it, and the session has
 * read BATS since every unproven write went out: it won't again on its own before the next settings poll
 * (180–300 s), as its confirm saw the old value and gives up — a commit that outlasted the confirm. So the
 * step-down asks for one at once if the latest readback predates what the hall shows (it can't have seen
 * it), else once it is READBACK_REQUEST_INTERVAL_MS old, and again whenever the readback answering the
 * last request is that old without proving the cap. One request at a time: the session keeps it until
 * BATS decodes, past a silent confirm phase, for SETTINGS_READBACK_REQUEST_LIFETIME_MS at most. A
 * readback older than a write is left to that write's own confirm while one can still come.
 */
export function nextReadbackRequests(
  progress: SteppingDown,
  inputs: Pick<BuyWindowEndInputs, "limitReadback" | "unprovenLimitWrites">,
  { limitEvidence, hallSettledForMs }: { limitEvidence: LimitEvidence; hallSettledForMs: number | undefined },
  nowMs: number,
  events: StepDownEvent[]
): Pick<SteppingDown, "readbackRequests" | "lastReadbackRequestAtMs"> {
  const unchanged = {
    readbackRequests: progress.readbackRequests,
    lastReadbackRequestAtMs: progress.lastReadbackRequestAtMs,
  };
  if (limitEvidence === "shows_cap" || hallSettledForMs === undefined || hallSettledForMs < SETTLED_FOR_MS) {
    return unchanged;
  }
  const readback = inputs.limitReadback;
  const ownConfirmStillDue = inputs.unprovenLimitWrites.some(
    write =>
      readback !== undefined &&
      write.sentAtMs >= readback.observedAtMs &&
      nowMs - write.sentAtMs < OWN_CONFIRM_DUE_WITHIN_MS
  );
  if (ownConfirmStillDue) return unchanged;
  const lastRequestAtMs = progress.lastReadbackRequestAtMs;
  const requestStillOpen =
    lastRequestAtMs !== undefined &&
    !(readback && readback.observedAtMs > lastRequestAtMs) &&
    nowMs - lastRequestAtMs < SETTINGS_READBACK_REQUEST_LIFETIME_MS;
  if (requestStillOpen) return unchanged;
  const hallSettledSinceMs = nowMs - hallSettledForMs;
  const readbackSinceHallSettledAtMs =
    readback && readback.observedAtMs >= hallSettledSinceMs ? readback.observedAtMs : -Infinity;
  const lastLookAtMs = Math.max(readbackSinceHallSettledAtMs, lastRequestAtMs ?? -Infinity);
  if (nowMs - lastLookAtMs < READBACK_REQUEST_INTERVAL_MS) return unchanged;
  events.push({
    kind: "readback_requested",
    afterMs: nowMs - progress.startedAtMs,
    limitEvidence,
    limitReadbackAmps: readback?.amps,
    hallSettledForMs,
    attempt: progress.readbackRequests + 1,
  });
  return { readbackRequests: progress.readbackRequests + 1, lastReadbackRequestAtMs: nowMs };
}

function isNewReadback(
  progress: SteppingDown,
  readback: AcChargingLimitReadback | undefined
): readback is AcChargingLimitReadback {
  return readback !== undefined && readback.observedAtMs !== progress.lastLimitReadbackAtMs;
}
