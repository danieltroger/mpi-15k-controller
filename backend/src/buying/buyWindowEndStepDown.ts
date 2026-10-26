/**
 * Pure state machine for ending a buy window in two steps instead of one: first cap AC charging at
 * the idle limit (MUCHGC0100), and only once that has taken effect allow EDB0. No I/O, no timers, no
 * solid-js — the reactive graph around it is buyingSetterWiring.ts; the released phase (EDB0 retries)
 * is buyWindowEndRelease.ts.
 *
 * Why: the inverter latched fault 14 ("Inverter DC current exceed permit range when feed power") at
 * 3 of 211 one-step ends of a heavy grid charge, all three at night (2025-01-08, 2025-10-30, 2026-10-21,
 * the last one for 59 h). MUCHGC0100 and EDB0 went out ~1.2 s apart, EDB0 took effect within ~0.2 s —
 * before the 10 A cap had committed — so the bridge went from rectifying ~14.5 kW straight to inverting
 * (#53).
 *
 * Every time here is one monotonic clock (performance.now() ms in production, the same clock the
 * inverter session records its sends on).
 */
import { type Released, releasedAt, whileReleased } from "./buyWindowEndRelease.ts";

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
 * A write can still commit up to this long after it went out: setters apply on the inverter's
 * housekeeping cycle, ~6 s after the write under light traffic (schedulerCore.ts) — 12 s is #48's own
 * point for trusting a confirm, and #62's keep threshold for gap 0. Measured from the session's record
 * of the send, so it holds whatever the quiet-gap mode: a readback inside it may predate the write's
 * commit, so the step-down only lets the hall vouch for the cap once this has passed.
 */
export const READBACK_COMMIT_MARGIN_MS = 12_000;
/**
 * Give up waiting and send EDB0 anyway. Normal step-downs take ~12.5 s (#48: the confirm after the
 * 12 s quiet gap; #62's gap 0: the last higher-limit send + 12 s + the 3 s settle at most). 120 s also
 * covers a confirm that gave up: the one re-asserted MUCHGC0100 goes out 60 s after the first send (the
 * identical-setter gate) and confirms ~12 s later.
 */
export const STEP_DOWN_TIMEOUT_MS = 120_000;
/**
 * If the timeout finds the hall fresh and above the allowance, the cap is demonstrably not in effect
 * and EDB0 would be exactly the one-step stop that latched F14: the step-down errorLogs, holds this much
 * longer — one 180 s settings poll, so a fresh BATS shows the real limit and the cap can be re-asserted
 * once more — and only then sends EDB0 regardless (errorLogged again). The cost of holding is grid
 * import at the limit the window last set (sized for the fuse at that moment) for ≤ 5 min in total
 * after the window, against a ~1.4 % chance per hard stop of a latched inverter.
 */
export const STEP_DOWN_EXTENSION_MS = 180_000;
/**
 * MUCHGC0100 is re-queued once when a BATS readback during the step-down still shows a higher limit
 * (once more during an extension): #48 leaves re-sending a write whose confirm gave up to its owner.
 * Bounded, so that a cap the inverter never applies costs a send or two, never a loop.
 */
export const MAX_LIMIT_REASSERTIONS = 1;

/** The BATS "max. AC charging current" readback, stamped when the shell observed it (same clock as nowMs) */
export type AcChargingLimitReadback = { amps: number; observedAtMs: number };
/** The HECS "AC charge battery" readback, stamped like the BATS one (-Infinity: from before the shell existed) */
export type AcChargingReading = { state: "enabled" | "disabled"; observedAtMs: number };

export type BuyWindowEndInputs = {
  /** chargingAmperageForBuying is set — a buy window wants grid charging (feeding may still be switching off) */
  gridChargingWanted: boolean;
  acChargingReadback: AcChargingReading | undefined;
  /** Latest BATS readback of the AC charging limit */
  limitReadback: AcChargingLimitReadback | undefined;
  /** When the session last sent a MUCHGC above the idle cap (undefined: never) */
  lastAboveIdleLimitSentAtMs: number | undefined;
  /** When the session last sent EDB1 (undefined: never) */
  lastAcChargingEnableSentAtMs: number | undefined;
  /** Hall sensor 2 battery current (+ = charging), undefined when there is no fresh reading */
  hallBatteryAmps: number | undefined;
  solarWatts: number | undefined;
  batteryVoltage: number | undefined;
};

export type SteppingDown = {
  phase: "stepping_down";
  startedAtMs: number;
  /** When the latest readback first showed the cap (undefined while it doesn't) */
  limitConfirmedAtMs: number | undefined;
  /** Since when the hall current has stayed within the allowance, continuously */
  hallSettledSinceMs: number | undefined;
  /** When the last BATS readback this step-down looked at was observed — to spot a new one */
  lastLimitReadbackAtMs: number | undefined;
  limitReassertions: number;
  /** When EDB0 goes out regardless: the timeout, pushed out once by STEP_DOWN_EXTENSION_MS */
  deadlineMs: number;
  extended: boolean;
};

export type StepDownProgress = { phase: "idle" } | SteppingDown | Released;

export type BuyWindowEndStepDownState = { progress: StepDownProgress };

/** What the latest BATS readback says about the cap */
export type LimitEvidence = "none" | "shows_higher_limit" | "predates_last_higher_limit_write" | "shows_cap";

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
      kind: "hold_extended";
      afterMs: number;
      extensionMs: number;
      hallBatteryAmps: number;
      allowedHallAmps: number;
      limitReadback: AcChargingLimitReadback | undefined;
      limitEvidence: LimitEvidence;
    }
  | {
      kind: "timed_out";
      afterMs: number;
      limitReadback: AcChargingLimitReadback | undefined;
      limitEvidence: LimitEvidence;
      hallBatteryAmps: number | undefined;
      allowedHallAmps: number;
      /** The hall was fresh and above the allowance: EDB0 goes out with the cap demonstrably not in effect */
      hallAboveAllowance: boolean;
    }
  | { kind: "cancelled"; afterMs: number; reason: "grid charging wanted again" | "AC charging already disabled" }
  | { kind: "ac_charging_disabled_confirmed"; afterMs: number; afterReleaseMs: number }
  | { kind: "release_superseded"; afterReleaseMs: number }
  | { kind: "edb0_retry"; afterReleaseMs: number; attempt: number }
  | {
      kind: "edb0_retries_exhausted";
      afterReleaseMs: number;
      attempts: number;
      lastLimitReadbackAmps: number | undefined;
    };

export function stepBuyWindowEndStepDown(
  state: BuyWindowEndStepDownState,
  inputs: BuyWindowEndInputs,
  nowMs: number
): { state: BuyWindowEndStepDownState; events: StepDownEvent[] } {
  const events: StepDownEvent[] = [];
  const progress = state.progress;
  if (progress.phase === "idle") return { state: { progress: fromIdle(inputs, nowMs, events) }, events };
  if (progress.phase === "stepping_down") {
    return { state: { progress: whileSteppingDown(progress, inputs, nowMs, events) }, events };
  }
  return { state: { progress: whileReleased(progress, inputs, nowMs, events) }, events };
}

export function initialBuyWindowEndStepDownState(): BuyWindowEndStepDownState {
  // Nothing is persisted: after a restart the readbacks alone re-create a step-down still in progress
  return { progress: { phase: "idle" } };
}

/** While true, EDB0 must not be sent although no buy window wants AC charging */
export function holdsAcChargingOn(state: BuyWindowEndStepDownState): boolean {
  return state.progress.phase === "stepping_down";
}

/** Grows by one each time the step-down wants MUCHGC0100 queued again (bounded) */
export function acChargingLimitReassertions(state: BuyWindowEndStepDownState): number {
  return state.progress.phase === "stepping_down" ? state.progress.limitReassertions : 0;
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

/** The session's send record → the two send times the step-down judges readbacks against */
export function lastRelevantSends(lastSentAtMsByCommand: Readonly<Record<string, number>>) {
  let lastAboveIdleLimitSentAtMs: number | undefined;
  for (const [command, sentAtMs] of Object.entries(lastSentAtMsByCommand)) {
    const limit = command.match(/^MUCHGC(\d{4})$/);
    if (!limit || Number(limit[1]) / 10 <= IDLE_AC_CHARGING_LIMIT_AMPS) continue;
    lastAboveIdleLimitSentAtMs = Math.max(lastAboveIdleLimitSentAtMs ?? -Infinity, sentAtMs);
  }
  return { lastAboveIdleLimitSentAtMs, lastAcChargingEnableSentAtMs: lastSentAtMsByCommand["EDB1"] };
}

function fromIdle(inputs: BuyWindowEndInputs, nowMs: number, events: StepDownEvent[]): StepDownProgress {
  if (inputs.gridChargingWanted || !acChargingMayBeOn(inputs)) return { phase: "idle" };
  events.push({
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
    deadlineMs: nowMs + STEP_DOWN_TIMEOUT_MS,
    extended: false,
  };
  // Evaluated right away: a readback that already shows the cap counts from the first step
  return whileSteppingDown(started, inputs, nowMs, events);
}

/**
 * HECS says "enabled" with no window wanting it — a window just ended (or was shrunk/deleted), or the
 * controller restarted mid-step-down or after a window ended while it was down — or its "disabled" may
 * predate an EDB1 still committing: a window that ends a few seconds after it started (the charge
 * reaches 260–290 A ~3 s after EDB1 commits).
 */
function acChargingMayBeOn(inputs: BuyWindowEndInputs): boolean {
  const reading = inputs.acChargingReadback;
  if (reading?.state === "enabled") return true;
  // Never switched on through this session: an unknown or "disabled" HECS stands
  if (inputs.lastAcChargingEnableSentAtMs === undefined) return false;
  return !observedAfterCommitOf(reading, inputs.lastAcChargingEnableSentAtMs);
}

function whileSteppingDown(
  progress: SteppingDown,
  inputs: BuyWindowEndInputs,
  nowMs: number,
  events: StepDownEvent[]
): StepDownProgress {
  const afterMs = nowMs - progress.startedAtMs;
  // A window extended or re-entered, or a new one starting: charging at its amperage resumes
  if (inputs.gridChargingWanted) {
    events.push({ kind: "cancelled", afterMs, reason: "grid charging wanted again" });
    return { phase: "idle" };
  }
  const acCharging = inputs.acChargingReadback;
  if (acCharging?.state === "disabled" && observedAfterCommitOf(acCharging, inputs.lastAcChargingEnableSentAtMs)) {
    events.push({ kind: "cancelled", afterMs, reason: "AC charging already disabled" });
    return { phase: "idle" };
  }

  const limitReassertions = nextLimitReassertions(progress, inputs.limitReadback, afterMs, events);
  // Re-judged every step (not latched): only the latest readback says what the inverter holds now
  const limitEvidence = limitEvidenceOf(inputs.limitReadback, inputs.lastAboveIdleLimitSentAtMs);
  const capReadback = limitEvidence === "shows_cap" ? inputs.limitReadback : undefined;
  const limitConfirmedAtMs = capReadback ? progress.limitConfirmedAtMs ?? nowMs : undefined;
  const allowedAmps = allowedHallAmps(inputs);
  if (capReadback && progress.limitConfirmedAtMs === undefined) {
    events.push({
      kind: "limit_confirmed",
      afterMs,
      limitAmps: capReadback.amps,
      hallBatteryAmps: inputs.hallBatteryAmps,
      allowedHallAmps: allowedAmps,
    });
  }
  const hallBatteryAmps = inputs.hallBatteryAmps;
  const hallWithinAllowance = hallBatteryAmps !== undefined && hallBatteryAmps <= allowedAmps;
  const hallSettledSinceMs = hallWithinAllowance ? progress.hallSettledSinceMs ?? nowMs : undefined;
  // Until then a higher-limit write may still commit, so a low hall (and a 10 A readback) don't prove much
  const commitHorizonMs = (inputs.lastAboveIdleLimitSentAtMs ?? -Infinity) + READBACK_COMMIT_MARGIN_MS;

  if (capReadback && limitConfirmedAtMs !== undefined) {
    const limitConfirmedAfterMs = limitConfirmedAtMs - progress.startedAtMs;
    // The hall has to stay low for the settle time past the horizon: a write that commits by then shows
    // up as current within ~1 s — if the pack takes it; if it doesn't, EDB0 stops no current either
    if (
      hallBatteryAmps !== undefined &&
      hallSettledSinceMs !== undefined &&
      nowMs - Math.max(hallSettledSinceMs, commitHorizonMs) >= SETTLED_FOR_MS
    ) {
      events.push({
        kind: "released",
        afterMs,
        limitConfirmedAfterMs,
        hallBatteryAmps,
        allowedHallAmps: allowedAmps,
        hallSettledForMs: nowMs - hallSettledSinceMs,
      });
      return releasedAt(progress.startedAtMs, nowMs);
    }
    // current_measuring disabled or erroring: only a readback beyond the horizon can vouch for the cap
    if (
      hallBatteryAmps === undefined &&
      capReadback.observedAtMs > commitHorizonMs &&
      nowMs - limitConfirmedAtMs >= SETTLED_FOR_MS
    ) {
      events.push({ kind: "released_without_hall", afterMs, limitConfirmedAfterMs });
      return releasedAt(progress.startedAtMs, nowMs);
    }
  }
  const next: SteppingDown = {
    ...progress,
    limitConfirmedAtMs,
    hallSettledSinceMs,
    lastLimitReadbackAtMs: inputs.limitReadback?.observedAtMs,
    limitReassertions,
  };
  if (nowMs < progress.deadlineMs) return next;
  const hallAboveAllowance = hallBatteryAmps !== undefined && hallBatteryAmps > allowedAmps;
  if (hallAboveAllowance && !progress.extended) {
    events.push({
      kind: "hold_extended",
      afterMs,
      extensionMs: STEP_DOWN_EXTENSION_MS,
      hallBatteryAmps,
      allowedHallAmps: allowedAmps,
      limitReadback: inputs.limitReadback,
      limitEvidence,
    });
    return { ...next, deadlineMs: nowMs + STEP_DOWN_EXTENSION_MS, extended: true };
  }
  events.push({
    kind: "timed_out",
    afterMs,
    limitReadback: inputs.limitReadback,
    limitEvidence,
    hallBatteryAmps,
    allowedHallAmps: allowedAmps,
    hallAboveAllowance,
  });
  return releasedAt(progress.startedAtMs, nowMs);
}

/** A new BATS readback during the step-down that still shows a higher limit re-asserts the cap (bounded) */
function nextLimitReassertions(
  progress: SteppingDown,
  readback: AcChargingLimitReadback | undefined,
  afterMs: number,
  events: StepDownEvent[]
): number {
  const isNewReadback = readback !== undefined && readback.observedAtMs !== progress.lastLimitReadbackAtMs;
  if (!isNewReadback || readback.amps <= IDLE_AC_CHARGING_LIMIT_AMPS) return progress.limitReassertions;
  const allowedReassertions = MAX_LIMIT_REASSERTIONS + (progress.extended ? 1 : 0);
  if (progress.limitReassertions >= allowedReassertions) return progress.limitReassertions;
  events.push({ kind: "limit_reasserted", afterMs, limitReadbackAmps: readback.amps });
  return progress.limitReassertions + 1;
}

function limitEvidenceOf(
  readback: AcChargingLimitReadback | undefined,
  lastAboveIdleLimitSentAtMs: number | undefined
): LimitEvidence {
  if (!readback) return "none";
  if (readback.amps > IDLE_AC_CHARGING_LIMIT_AMPS) return "shows_higher_limit";
  if (lastAboveIdleLimitSentAtMs !== undefined && readback.observedAtMs <= lastAboveIdleLimitSentAtMs) {
    return "predates_last_higher_limit_write";
  }
  return "shows_cap";
}

/** Observed more than READBACK_COMMIT_MARGIN_MS after `sentAtMs` (or there was no such send) */
function observedAfterCommitOf(reading: { observedAtMs: number } | undefined, sentAtMs: number | undefined): boolean {
  if (!reading) return false;
  return sentAtMs === undefined || reading.observedAtMs > sentAtMs + READBACK_COMMIT_MARGIN_MS;
}
