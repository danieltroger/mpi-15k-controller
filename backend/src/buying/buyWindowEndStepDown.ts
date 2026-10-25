/**
 * Pure state machine for ending a buy window in two steps instead of one: first cap AC charging at
 * the idle limit (MUCHGC0100), and only once that has taken effect allow EDB0. No I/O, no timers, no
 * solid-js — the reactive shell is useBuyWindowEndStepDown.ts.
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
 * covers a confirm that gave up, where the re-queued MUCHGC0100 may go out again 60 s after the first
 * send (the identical-setter gate) and confirm 12 s later.
 */
export const STEP_DOWN_TIMEOUT_MS = 120_000;

/** The BATS "max. AC charging current" readback, stamped when the shell observed it (same clock as nowMs) */
export type AcChargingLimitReadback = { amps: number; observedAtMs: number };

export type BuyWindowEndInputs = {
  /** chargingAmperageForBuying is set — a buy window wants grid charging (feeding may still be switching off) */
  gridChargingWanted: boolean;
  /** The AC charging limit currently being asked of the inverter (wantedAcChargingLimitAmps) */
  wantedLimitAmps: number;
  /** HECS "AC charge battery" readback */
  acChargingReadback: "enabled" | "disabled" | undefined;
  /** Latest BATS readback of the AC charging limit */
  limitReadback: AcChargingLimitReadback | undefined;
  /** Hall sensor 2 battery current (+ = charging), undefined when there is no fresh reading */
  hallBatteryAmps: number | undefined;
  solarWatts: number | undefined;
  batteryVoltage: number | undefined;
};

export type StepDownProgress =
  | { phase: "idle" }
  | {
      phase: "stepping_down";
      startedAtMs: number;
      /** When the latest readback first proved the idle cap (undefined while it doesn't) */
      limitConfirmedAtMs: number | undefined;
      /** Since when the hall current has stayed within the allowance, continuously */
      hallSettledSinceMs: number | undefined;
    }
  /** EDB0 is allowed; waiting for HECS to show AC charging disabled so a stale "enabled" can't start another step-down */
  | { phase: "released"; startedAtMs: number; releasedAtMs: number };

export type BuyWindowEndStepDownState = {
  progress: StepDownProgress;
  /** Whether the previous step wanted a limit above the idle one */
  aboveIdleLimitWanted: boolean;
  /**
   * The last instant a limit above the idle one was wanted. A readback from before it can predate that
   * write's commit, so it can't vouch for the cap (e.g. a window extended and shrunk again mid-step-down).
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
  | { kind: "release_superseded"; afterReleaseMs: number };

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

/** While true, AC charging must stay enabled (EDB1 desired) even though no buy window wants it */
export function holdsAcChargingOn(state: BuyWindowEndStepDownState): boolean {
  return state.progress.phase === "stepping_down";
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

type SteppingDown = Extract<StepDownProgress, { phase: "stepping_down" }>;

function nextProgress(progress: StepDownProgress, context: StepContext): StepDownProgress {
  if (progress.phase === "idle") return fromIdle(context);
  if (progress.phase === "stepping_down") return whileSteppingDown(progress, context);
  return whileReleased(progress, context);
}

function fromIdle(context: StepContext): StepDownProgress {
  const { inputs, nowMs } = context;
  // "enabled" with no window wanting it: a window just ended (or was shrunk/deleted), or the controller
  // restarted mid-step-down or after a window ended while it was down — every case where EDB0 would go
  // out at full current
  if (inputs.gridChargingWanted || inputs.acChargingReadback !== "enabled") return { phase: "idle" };
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
  };
  // Evaluated right away: a readback that already proves the cap counts from the first step
  return whileSteppingDown(started, context);
}

function whileSteppingDown(progress: SteppingDown, context: StepContext): StepDownProgress {
  const { inputs, nowMs, events } = context;
  const afterMs = nowMs - progress.startedAtMs;
  // A window extended or re-entered, or a new one starting: charging at its amperage resumes
  if (inputs.gridChargingWanted) {
    events.push({ kind: "cancelled", afterMs, reason: "grid charging wanted again" });
    return { phase: "idle" };
  }
  if (inputs.acChargingReadback === "disabled") {
    events.push({ kind: "cancelled", afterMs, reason: "AC charging already disabled" });
    return { phase: "idle" };
  }

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
  return { ...progress, limitConfirmedAtMs, hallSettledSinceMs };
}

function whileReleased(
  progress: Extract<StepDownProgress, { phase: "released" }>,
  context: StepContext
): StepDownProgress {
  const { inputs, nowMs, events } = context;
  if (inputs.gridChargingWanted) {
    events.push({ kind: "release_superseded", afterReleaseMs: nowMs - progress.releasedAtMs });
    return { phase: "idle" };
  }
  if (inputs.acChargingReadback === "disabled") {
    events.push({
      kind: "ac_charging_disabled_confirmed",
      afterMs: nowMs - progress.startedAtMs,
      afterReleaseMs: nowMs - progress.releasedAtMs,
    });
    return { phase: "idle" };
  }
  return progress;
}

function released(progress: SteppingDown, nowMs: number): StepDownProgress {
  return { phase: "released", startedAtMs: progress.startedAtMs, releasedAtMs: nowMs };
}

/**
 * The latest readback proves the idle cap only if it shows it and was observed after the last moment a
 * higher limit was wanted. #48's session runs no query in the 12 s quiet gap after a write, so any BATS
 * decoded after that moment comes ≥ 12 s after every higher-limit write — the same point at which the
 * session's own confirm trusts BATS. An earlier one may predate such a write's commit.
 */
function readbackProvingIdleLimit(
  readback: AcChargingLimitReadback | undefined,
  aboveIdleLimitWantedUntilMs: number | undefined
): AcChargingLimitReadback | undefined {
  if (!readback || readback.amps > IDLE_AC_CHARGING_LIMIT_AMPS) return undefined;
  const observedBeforeHigherLimitEnded =
    aboveIdleLimitWantedUntilMs !== undefined && readback.observedAtMs <= aboveIdleLimitWantedUntilMs;
  return observedBeforeHigherLimitEnded ? undefined : readback;
}
