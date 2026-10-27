/**
 * Pure state machine for ending a buy window in two steps instead of one: first cap AC charging at
 * the idle limit (MUCHGC0100), and only once that has taken effect allow EDB0. No I/O, no timers, no
 * solid-js — the reactive graph around it is buyingSetterWiring.ts. What counts as proof (the hall,
 * BATS and #62's write chains) is buyWindowEndEvidence.ts, what it asks the session for while it waits
 * is buyWindowEndAsks.ts, the released phase (EDB0 retries) is buyWindowEndRelease.ts.
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
import { nextAlternateCapRequests, nextLimitReassertions, nextReadbackRequests } from "./buyWindowEndAsks.ts";
import {
  allowedHallAmps,
  enableMayLand,
  higherLimitMayLand,
  IDLE_AC_CHARGING_LIMIT_AMPS,
  limitEvidenceOf,
  SETTLED_FOR_MS,
} from "./buyWindowEndEvidence.ts";
import { releasedAt, whileReleased } from "./buyWindowEndRelease.ts";
import type {
  BuyWindowEndInputs,
  BuyWindowEndStepDownState,
  StepDownEvent,
  StepDownProgress,
  SteppingDown,
} from "./buyWindowEndStepDown.types.ts";
// Re-exported so the step-down keeps one import path for its consumers
export type {
  AcChargingLimitReadback,
  AcChargingReading,
  BuyWindowEndInputs,
  BuyWindowEndStepDownState,
  LimitEvidence,
  StepDownEvent,
  StepDownProgress,
  SteppingDown,
} from "./buyWindowEndStepDown.types.ts";

/**
 * Give up waiting and send EDB0 anyway. Normal step-downs take ~12.5 s (the cap's first confirm, ~9.5 s
 * after the window end, plus the 3 s settle; a commit that needs one more re-check adds 4 s). 120 s also
 * covers a confirm that gave up: the one re-asserted MUCHGC0100 goes out 60 s after the first send (the
 * identical-setter gate) and confirms ~9 s later.
 */
export const STEP_DOWN_TIMEOUT_MS = 120_000;
/**
 * If the timeout finds the hall fresh and above the allowance, the cap is demonstrably not in effect
 * and EDB0 would be exactly the one-step stop that latched F14: the step-down errorLogs, sends the
 * alternate cap at once and holds this much longer — the alternate cap's send, its commit and its
 * confirm's whole window (re-checked until 55 s after the write) fit, a cap that hasn't applied by then
 * won't — and only then
 * sends EDB0 regardless (errorLogged again). Holding costs grid import at the limit the inverter still
 * applies, which no longer follows house load, for ≤ 3 min after the window, against a ~1.4 % chance
 * per hard stop of a latched inverter.
 */
export const STEP_DOWN_EXTENSION_MS = 60_000;

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

/** Grows by one each time the step-down wants the alternate cap (ALTERNATE_CAP_AMPS) queued (at most twice) */
export function alternateCapRequests(state: BuyWindowEndStepDownState): number {
  return state.progress.phase === "stepping_down" ? state.progress.alternateCapRequests : 0;
}

/** Grows by one each time the step-down wants the session to read the settings again (buyWindowEndAsks.ts) */
export function settingsReadbackRequests(state: BuyWindowEndStepDownState): number {
  return state.progress.phase === "stepping_down" ? state.progress.readbackRequests : 0;
}

/** The MUCHGC target: the window's amperage while buying, the idle cap otherwise */
export function wantedAcChargingLimitAmps(shouldBuy: boolean, chargingAmperageForBuying: number | undefined): number {
  if (!shouldBuy) return IDLE_AC_CHARGING_LIMIT_AMPS;
  return chargingAmperageForBuying ?? IDLE_AC_CHARGING_LIMIT_AMPS;
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
    alternateCapRequests: 0,
    readbackRequests: 0,
    lastReadbackRequestAtMs: undefined,
    deadlineMs: nowMs + STEP_DOWN_TIMEOUT_MS,
    extended: false,
  };
  // Evaluated right away: a readback that already shows the cap counts from the first step
  return whileSteppingDown(started, inputs, nowMs, events);
}

/**
 * HECS says "enabled" with no window wanting it — a window just ended (or was shrunk/deleted), or the
 * controller restarted mid-step-down or after a window ended while it was down — or an EDB1 may still
 * switch it on whatever HECS shows: a window that ends a few seconds after it started (the charge reaches
 * 260–290 A ~3 s after EDB1 commits).
 */
function acChargingMayBeOn(inputs: BuyWindowEndInputs): boolean {
  return inputs.acChargingReadback?.state === "enabled" || enableMayLand(inputs.unprovenAcChargingWrites);
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
  if (inputs.acChargingReadback?.state === "disabled" && !enableMayLand(inputs.unprovenAcChargingWrites)) {
    events.push({ kind: "cancelled", afterMs, reason: "AC charging already disabled" });
    return { phase: "idle" };
  }

  // Re-judged every step (not latched): only the latest readback and chain say what the inverter holds now
  const limitEvidence = limitEvidenceOf(inputs.limitReadback, inputs.unprovenLimitWrites);
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
  const hallSettledForMs = hallSettledSinceMs === undefined ? undefined : nowMs - hallSettledSinceMs;

  if (capReadback && limitConfirmedAtMs !== undefined) {
    const limitConfirmedAfterMs = limitConfirmedAtMs - progress.startedAtMs;
    // The cap is proven in BATS; the hall has to show it in effect, through the ringing after its commit.
    // A pack that takes little current anyway passes too: EDB0 then stops little current either.
    if (hallBatteryAmps !== undefined && hallSettledForMs !== undefined && hallSettledForMs >= SETTLED_FOR_MS) {
      events.push({
        kind: "released",
        afterMs,
        limitConfirmedAfterMs,
        hallBatteryAmps,
        allowedHallAmps: allowedAmps,
        hallSettledForMs,
      });
      return releasedAt(progress.startedAtMs, nowMs);
    }
    // current_measuring disabled or erroring: the proven readback alone vouches for the cap
    if (hallBatteryAmps === undefined && nowMs - limitConfirmedAtMs >= SETTLED_FOR_MS) {
      events.push({ kind: "released_without_hall", afterMs, limitConfirmedAfterMs });
      return releasedAt(progress.startedAtMs, nowMs);
    }
  }
  const next: SteppingDown = {
    ...progress,
    limitConfirmedAtMs,
    hallSettledSinceMs,
    lastLimitReadbackAtMs: inputs.limitReadback?.observedAtMs,
    limitReassertions: nextLimitReassertions(progress, inputs.limitReadback, nowMs, events),
    alternateCapRequests: nextAlternateCapRequests(progress, inputs, nowMs, events),
    ...nextReadbackRequests(progress, inputs, { limitEvidence, hallSettledForMs }, nowMs, events),
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
    return {
      ...next,
      deadlineMs: nowMs + STEP_DOWN_EXTENSION_MS,
      extended: true,
      alternateCapRequests: next.alternateCapRequests + 1,
    };
  }
  events.push({
    kind: "timed_out",
    afterMs,
    limitReadback: inputs.limitReadback,
    limitEvidence,
    hallBatteryAmps,
    allowedHallAmps: allowedAmps,
    hallAboveAllowance,
    hallSettledForMs,
    higherLimitMayLand: higherLimitMayLand(inputs.unprovenLimitWrites),
  });
  return releasedAt(progress.startedAtMs, nowMs);
}
