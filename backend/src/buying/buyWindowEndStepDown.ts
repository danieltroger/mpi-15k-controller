/**
 * Pure state machine for ending a buy window in two steps instead of one: first cap AC charging at
 * the idle limit (MUCHGC0100), and only once that has taken effect allow EDB0. No I/O, no timers, no
 * solid-js — the reactive graph around it is buyingSetterWiring.ts.
 *
 * Why: the inverter latched fault 14 ("Inverter DC current exceed permit range when feed power") at
 * 3 of 211 one-step ends of a heavy grid charge, all three at night (2025-01-08, 2025-10-30, 2026-10-21,
 * the last one for 59 h). MUCHGC0100 and EDB0 went out ~1.2 s apart, EDB0 took effect within ~0.2 s —
 * before the 10 A cap had committed — so the bridge went from rectifying ~14.5 kW straight to inverting
 * (#53).
 *
 * Every time here is one monotonic clock (performance.now() ms in production).
 */

/**
 * The AC charging limit the inverter holds whenever it isn't buying (MUCHGC0100), in case it glitches
 * and charges from the grid although AC charging is disabled — and the first step of every window end.
 */
export const IDLE_AC_CHARGING_LIMIT_AMPS = 10;
/**
 * How far above the idle limit (plus whatever PV can add) the hall current may sit and still count as
 * "the cap is in effect". Measured at small AC charging limits (Influx, 2025-11 → 2026-04, the hall
 * sensor 2 at 4 Hz): hall − (limit + PV watts / battery volts) has a night median of +0.5 A (p95 +2.7 A)
 * and a daytime p95 of +8.4 A, with excursions to ~+15 A while PV ramps (the GS PV reading lags the
 * hall). With 20 A the condition held for 3 s within ≤ 8.8 s from every start point of every such
 * stretch; 0 A left 3 657 start points never satisfied. 30 A at night is still an ~8× smaller step
 * than the 240–284 A of the three F14 window ends.
 */
export const HALL_ALLOWANCE_ABOVE_IDLE_LIMIT_AMPS = 20;
/**
 * The hall current must stay within the allowance this long. Across 130 committed in-window MUCHGC
 * step-downs (AC charging staying on) the current fell in one go — 10–90 % in a median 0.5 s, p90
 * 0.75 s — and was within max(5 A, 5 %) of its new level after a median 0.5 s, p90 1.25 s, with brief
 * ringing (e.g. 287 → 6 → 39 → 22 A over ~1.5 s with 1.6 kW PV, 2026-04-03).
 */
export const SETTLED_FOR_MS = 3_000;
/**
 * Give up waiting and send EDB0 anyway (with a warnLog). Normal step-downs take ~12.5 s: the commit
 * lands ~6 s after the write, and #48's confirm readback runs after its 12 s quiet gap. 120 s also
 * covers a confirm that gave up: the one re-asserted MUCHGC0100 goes out 60 s after the first send
 * (the identical-setter gate) and confirms ~12 s later.
 */
export const STEP_DOWN_TIMEOUT_MS = 120_000;
/**
 * A readback only vouches for the inverter's state once it is this much newer than the last moment a
 * higher limit (and with it EDB1) was wanted. A setter applies on the inverter's housekeeping cycle,
 * ~6 s after the write under light traffic (schedulerCore.ts), so a readback right after a write can
 * still show the state before it. #48's 12 s post-write quiet gap guarantees the distance today, but
 * #62's gap-0 mode keeps polling straight after a write, so the step-down enforces it itself — 12 s,
 * the same point at which #48's own confirm trusts a readback. The wish ends no earlier than the last
 * such write went out, so this is measured from a safe side.
 */
export const READBACK_COMMIT_MARGIN_MS = 12_000;
/**
 * MUCHGC0100 is re-queued once when a BATS readback during the step-down still shows a higher limit:
 * #48 leaves re-sending a write whose confirm gave up to its owner. Once, so that a cap the inverter
 * never applies costs one extra send inside the timeout, never a loop.
 */
export const MAX_LIMIT_REASSERTIONS = 1;
/**
 * After EDB0 is released, a HECS readback that still shows AC charging enabled this long after the last
 * EDB0 request asks for EDB0 again: #48's confirm (12 s) and its backoff re-check (30 s more) are over
 * by then, and the identical-setter gate wouldn't send it any sooner anyway.
 */
export const EDB0_RETRY_SPACING_MS = 60_000;
/** EDB0 re-requests before giving up loudly (errorLog); AC charging then stays at the 10 A cap until the next window */
export const MAX_EDB0_RETRIES = 2;

/** The BATS "max. AC charging current" readback, stamped when the shell observed it (same clock as nowMs) */
export type AcChargingLimitReadback = { amps: number; observedAtMs: number };
/** The HECS "AC charge battery" readback, stamped like the BATS one (-Infinity: from before the shell existed) */
export type AcChargingReading = { state: "enabled" | "disabled"; observedAtMs: number };

export type BuyWindowEndInputs = {
  /** chargingAmperageForBuying is set — a buy window wants grid charging (feeding may still be switching off) */
  gridChargingWanted: boolean;
  /** The AC charging limit currently being asked of the inverter (wantedAcChargingLimitAmps) */
  wantedLimitAmps: number;
  acChargingReadback: AcChargingReading | undefined;
  /** Latest BATS readback of the AC charging limit */
  limitReadback: AcChargingLimitReadback | undefined;
  /** Hall sensor 2 battery current (+ = charging), undefined when there is no fresh reading */
  hallBatteryAmps: number | undefined;
  solarWatts: number | undefined;
  batteryVoltage: number | undefined;
};

export type SteppingDown = {
  phase: "stepping_down";
  startedAtMs: number;
  /** When the latest readback first proved the idle cap (undefined while it doesn't) */
  limitConfirmedAtMs: number | undefined;
  /** Since when the hall current has stayed within the allowance, continuously */
  hallSettledSinceMs: number | undefined;
  /** When the last BATS readback this step-down looked at was observed — to spot a new one */
  lastLimitReadbackAtMs: number | undefined;
  limitReassertions: number;
};

/** EDB0 is allowed; waiting for a HECS readback newer than the release to show AC charging disabled */
export type Released = {
  phase: "released";
  startedAtMs: number;
  releasedAtMs: number;
  edb0Retries: number;
  lastEdb0RequestAtMs: number;
  edb0RetriesExhausted: boolean;
};

export type StepDownProgress = { phase: "idle" } | SteppingDown | Released;

export type BuyWindowEndStepDownState = {
  progress: StepDownProgress;
  /** Whether the previous step wanted a limit above the idle one */
  aboveIdleLimitWanted: boolean;
  /**
   * The last instant a limit above the idle one was wanted. Readbacks closer to it than
   * READBACK_COMMIT_MARGIN_MS can predate that write's commit (or EDB1's), so they can't vouch for the
   * inverter's state (e.g. a window extended and shrunk again mid-step-down, or one that ends seconds
   * after it started).
   */
  aboveIdleLimitWantedUntilMs: number | undefined;
};

export type StepDownEvent =
  | { kind: "started"; limitReadbackAmps: number | undefined; hallBatteryAmps: number | undefined }
  | {
      kind: "limit_confirmed";
      afterMs: number;
      limitAmps: number;
      hallBatteryAmps: number | undefined;
      allowedHallAmps: number;
    }
  | { kind: "limit_reasserted"; afterMs: number; limitReadbackAmps: number }
  | {
      kind: "released";
      afterMs: number;
      limitConfirmedAfterMs: number;
      hallBatteryAmps: number;
      allowedHallAmps: number;
      hallSettledForMs: number;
    }
  | { kind: "released_without_hall"; afterMs: number; limitConfirmedAfterMs: number }
  | {
      kind: "timed_out";
      afterMs: number;
      limitReadback: AcChargingLimitReadback | undefined;
      limitConfirmedAfterMs: number | undefined;
      hallBatteryAmps: number | undefined;
      allowedHallAmps: number;
    }
  | { kind: "cancelled"; afterMs: number; reason: "grid charging wanted again" | "AC charging already disabled" }
  | { kind: "ac_charging_disabled_confirmed"; afterMs: number; afterReleaseMs: number }
  | { kind: "release_superseded"; afterReleaseMs: number }
  | { kind: "edb0_retry"; afterReleaseMs: number; attempt: number }
  | { kind: "edb0_retries_exhausted"; afterReleaseMs: number; attempts: number };

export function stepBuyWindowEndStepDown(
  state: BuyWindowEndStepDownState,
  inputs: BuyWindowEndInputs,
  nowMs: number
): { state: BuyWindowEndStepDownState; events: StepDownEvent[] } {
  const aboveIdleLimitWanted = inputs.wantedLimitAmps > IDLE_AC_CHARGING_LIMIT_AMPS;
  // Stamped on every step that wants it AND on the step where that ends, so "until" is exact
  const aboveIdleLimitWantedUntilMs =
    aboveIdleLimitWanted || state.aboveIdleLimitWanted ? nowMs : state.aboveIdleLimitWantedUntilMs;
  const context: StepContext = { inputs, nowMs, aboveIdleLimitWantedUntilMs, events: [] };
  const progress = nextProgress(state.progress, context);
  return { state: { progress, aboveIdleLimitWanted, aboveIdleLimitWantedUntilMs }, events: context.events };
}

export function initialBuyWindowEndStepDownState(): BuyWindowEndStepDownState {
  // Nothing is persisted: after a restart the readbacks alone re-create a step-down still in progress
  return { progress: { phase: "idle" }, aboveIdleLimitWanted: false, aboveIdleLimitWantedUntilMs: undefined };
}

/** While true, EDB0 must not be sent although no buy window wants AC charging */
export function holdsAcChargingOn(state: BuyWindowEndStepDownState): boolean {
  return state.progress.phase === "stepping_down";
}

/** Grows by one each time the step-down wants MUCHGC0100 queued again (bounded by MAX_LIMIT_REASSERTIONS) */
export function acChargingLimitReassertions(state: BuyWindowEndStepDownState): number {
  return state.progress.phase === "stepping_down" ? state.progress.limitReassertions : 0;
}

/** Grows by one each time the released step-down wants EDB0 queued again (bounded by MAX_EDB0_RETRIES) */
export function edb0RetryRequests(state: BuyWindowEndStepDownState): number {
  return state.progress.phase === "released" ? state.progress.edb0Retries : 0;
}

/** The MUCHGC target: the window's amperage while buying, the idle cap otherwise */
export function wantedAcChargingLimitAmps(shouldBuy: boolean, chargingAmperageForBuying: number | undefined): number {
  if (!shouldBuy) return IDLE_AC_CHARGING_LIMIT_AMPS;
  return chargingAmperageForBuying ?? IDLE_AC_CHARGING_LIMIT_AMPS;
}

/**
 * Battery charging can only come from the AC charger and PV, so with the cap in effect the hall can't
 * exceed cap + PV/V (PV/V overstates PV's share: MPPT losses, and PV also feeds the house). Grid import
 * minus house load is deliberately not used: PV feeding the house directly makes it meaningless.
 */
export function allowedHallAmps(inputs: Pick<BuyWindowEndInputs, "solarWatts" | "batteryVoltage">): number {
  const solarAmps =
    inputs.solarWatts && inputs.batteryVoltage ? Math.max(0, inputs.solarWatts) / inputs.batteryVoltage : 0;
  return IDLE_AC_CHARGING_LIMIT_AMPS + HALL_ALLOWANCE_ABOVE_IDLE_LIMIT_AMPS + solarAmps;
}

type StepContext = {
  inputs: BuyWindowEndInputs;
  nowMs: number;
  aboveIdleLimitWantedUntilMs: number | undefined;
  events: StepDownEvent[];
};

function nextProgress(progress: StepDownProgress, context: StepContext): StepDownProgress {
  if (progress.phase === "idle") return fromIdle(context);
  if (progress.phase === "stepping_down") return whileSteppingDown(progress, context);
  return whileReleased(progress, context);
}

function fromIdle(context: StepContext): StepDownProgress {
  const { inputs, nowMs } = context;
  if (inputs.gridChargingWanted || !acChargingMayBeOn(inputs.acChargingReadback, context.aboveIdleLimitWantedUntilMs)) {
    return { phase: "idle" };
  }
  context.events.push({
    kind: "started",
    limitReadbackAmps: inputs.limitReadback?.amps,
    hallBatteryAmps: inputs.hallBatteryAmps,
  });
  const started: SteppingDown = {
    phase: "stepping_down",
    startedAtMs: nowMs,
    limitConfirmedAtMs: undefined,
    hallSettledSinceMs: undefined,
    lastLimitReadbackAtMs: inputs.limitReadback?.observedAtMs,
    limitReassertions: 0,
  };
  // Evaluated right away: a readback that already proves the cap counts from the first step
  return whileSteppingDown(started, context);
}

/**
 * HECS says "enabled" with no window wanting it — a window just ended (or was shrunk/deleted), or the
 * controller restarted mid-step-down or after a window ended while it was down — or its "disabled" is
 * too close to the last higher-limit wish to rule out an EDB1 still committing: a window that ends a
 * few seconds after it started (the charge reaches 260–290 A ~3 s after EDB1 commits).
 */
function acChargingMayBeOn(reading: AcChargingReading | undefined, aboveIdleLimitWantedUntilMs: number | undefined) {
  if (reading?.state === "enabled") return true;
  return aboveIdleLimitWantedUntilMs !== undefined && !readingIsSettledAfter(reading, aboveIdleLimitWantedUntilMs);
}

function whileSteppingDown(progress: SteppingDown, context: StepContext): StepDownProgress {
  const { inputs, nowMs, events } = context;
  const afterMs = nowMs - progress.startedAtMs;
  // A window extended or re-entered, or a new one starting: charging at its amperage resumes
  if (inputs.gridChargingWanted) {
    events.push({ kind: "cancelled", afterMs, reason: "grid charging wanted again" });
    return { phase: "idle" };
  }
  const acChargingReadback = inputs.acChargingReadback;
  if (
    acChargingReadback?.state === "disabled" &&
    readingIsSettledAfter(acChargingReadback, context.aboveIdleLimitWantedUntilMs)
  ) {
    events.push({ kind: "cancelled", afterMs, reason: "AC charging already disabled" });
    return { phase: "idle" };
  }

  const limitReassertions = nextLimitReassertions(progress, inputs.limitReadback, afterMs, events);
  // Re-judged every step (not latched): only the latest readback says what the inverter holds now
  const provingReadback = readbackProvingIdleLimit(inputs.limitReadback, context.aboveIdleLimitWantedUntilMs);
  const limitConfirmedAtMs = provingReadback ? progress.limitConfirmedAtMs ?? nowMs : undefined;
  const allowedAmps = allowedHallAmps(inputs);
  if (provingReadback && progress.limitConfirmedAtMs === undefined) {
    events.push({
      kind: "limit_confirmed",
      afterMs,
      limitAmps: provingReadback.amps,
      hallBatteryAmps: inputs.hallBatteryAmps,
      allowedHallAmps: allowedAmps,
    });
  }
  const hallBatteryAmps = inputs.hallBatteryAmps;
  const hallWithinAllowance = hallBatteryAmps !== undefined && hallBatteryAmps <= allowedAmps;
  const hallSettledSinceMs = hallWithinAllowance ? progress.hallSettledSinceMs ?? nowMs : undefined;

  if (limitConfirmedAtMs !== undefined) {
    const limitConfirmedAfterMs = limitConfirmedAtMs - progress.startedAtMs;
    if (
      hallBatteryAmps !== undefined &&
      hallSettledSinceMs !== undefined &&
      nowMs - hallSettledSinceMs >= SETTLED_FOR_MS
    ) {
      events.push({
        kind: "released",
        afterMs,
        limitConfirmedAfterMs,
        hallBatteryAmps,
        allowedHallAmps: allowedAmps,
        hallSettledForMs: nowMs - hallSettledSinceMs,
      });
      return released(progress, nowMs);
    }
    // current_measuring disabled or erroring: the readback plus the settle time is all there is
    if (hallBatteryAmps === undefined && nowMs - limitConfirmedAtMs >= SETTLED_FOR_MS) {
      events.push({ kind: "released_without_hall", afterMs, limitConfirmedAfterMs });
      return released(progress, nowMs);
    }
  }
  if (afterMs >= STEP_DOWN_TIMEOUT_MS) {
    events.push({
      kind: "timed_out",
      afterMs,
      limitReadback: inputs.limitReadback,
      limitConfirmedAfterMs: limitConfirmedAtMs === undefined ? undefined : limitConfirmedAtMs - progress.startedAtMs,
      hallBatteryAmps: inputs.hallBatteryAmps,
      allowedHallAmps: allowedAmps,
    });
    return released(progress, nowMs);
  }
  return {
    ...progress,
    limitConfirmedAtMs,
    hallSettledSinceMs,
    lastLimitReadbackAtMs: inputs.limitReadback?.observedAtMs,
    limitReassertions,
  };
}

/** A new BATS readback during the step-down that still shows a higher limit re-asserts the cap, once */
function nextLimitReassertions(
  progress: SteppingDown,
  readback: AcChargingLimitReadback | undefined,
  afterMs: number,
  events: StepDownEvent[]
): number {
  const isNewReadback =
    readback !== undefined &&
    readback.observedAtMs > progress.startedAtMs &&
    readback.observedAtMs !== progress.lastLimitReadbackAtMs;
  if (!isNewReadback || readback.amps <= IDLE_AC_CHARGING_LIMIT_AMPS) return progress.limitReassertions;
  if (progress.limitReassertions >= MAX_LIMIT_REASSERTIONS) return progress.limitReassertions;
  events.push({ kind: "limit_reasserted", afterMs, limitReadbackAmps: readback.amps });
  return progress.limitReassertions + 1;
}

function whileReleased(progress: Released, context: StepContext): StepDownProgress {
  const { inputs, nowMs, events } = context;
  const afterReleaseMs = nowMs - progress.releasedAtMs;
  if (inputs.gridChargingWanted) {
    events.push({ kind: "release_superseded", afterReleaseMs });
    return { phase: "idle" };
  }
  const reading = inputs.acChargingReadback;
  // Only a readback newer than the release can show what EDB0 did (an older "disabled" may be the
  // stale pre-window one that started this step-down)
  if (!reading || reading.observedAtMs <= progress.releasedAtMs) return progress;
  if (reading.state === "disabled") {
    events.push({ kind: "ac_charging_disabled_confirmed", afterMs: nowMs - progress.startedAtMs, afterReleaseMs });
    return { phase: "idle" };
  }
  const retryDue = reading.observedAtMs > progress.lastEdb0RequestAtMs + EDB0_RETRY_SPACING_MS;
  if (!retryDue || progress.edb0RetriesExhausted) return progress;
  if (progress.edb0Retries >= MAX_EDB0_RETRIES) {
    events.push({ kind: "edb0_retries_exhausted", afterReleaseMs, attempts: progress.edb0Retries });
    return { ...progress, edb0RetriesExhausted: true };
  }
  events.push({ kind: "edb0_retry", afterReleaseMs, attempt: progress.edb0Retries + 1 });
  return { ...progress, edb0Retries: progress.edb0Retries + 1, lastEdb0RequestAtMs: nowMs };
}

function released(progress: SteppingDown, nowMs: number): Released {
  return {
    phase: "released",
    startedAtMs: progress.startedAtMs,
    releasedAtMs: nowMs,
    edb0Retries: 0,
    lastEdb0RequestAtMs: nowMs,
    edb0RetriesExhausted: false,
  };
}

/** The latest readback proves the idle cap only if it shows it and is settled after the last higher-limit wish */
function readbackProvingIdleLimit(
  readback: AcChargingLimitReadback | undefined,
  aboveIdleLimitWantedUntilMs: number | undefined
): AcChargingLimitReadback | undefined {
  if (!readback || readback.amps > IDLE_AC_CHARGING_LIMIT_AMPS) return undefined;
  return readingIsSettledAfter(readback, aboveIdleLimitWantedUntilMs) ? readback : undefined;
}

/** Observed at least READBACK_COMMIT_MARGIN_MS after the last higher-limit wish (or there never was one) */
function readingIsSettledAfter(
  reading: { observedAtMs: number } | undefined,
  aboveIdleLimitWantedUntilMs: number | undefined
): boolean {
  if (aboveIdleLimitWantedUntilMs === undefined) return reading !== undefined;
  return reading !== undefined && reading.observedAtMs > aboveIdleLimitWantedUntilMs + READBACK_COMMIT_MARGIN_MS;
}
