/**
 * Test harness for the buy-window end step-down selftests: drives the pure state machine through
 * timelines of input changes. Timelines follow the native PI17 session (#48): a write commits ~6 s
 * after it goes out, its BATS confirm is decoded after the 12 s quiet gap, a failed confirm re-checks
 * after 30 s more, and an identical setter is re-sent no sooner than 60 s after the last one. Sends
 * are the session's record (`lastAboveIdleLimitSentAtMs`, `lastAcChargingEnableSentAtMs`): the ACK time.
 */
import {
  type AcChargingReading,
  type BuyWindowEndInputs,
  type BuyWindowEndStepDownState,
  holdsAcChargingOn,
  initialBuyWindowEndStepDownState,
  stepBuyWindowEndStepDown,
  type StepDownEvent,
} from "./buyWindowEndStepDown.ts";

export type Simulation = {
  state: BuyWindowEndStepDownState;
  inputs: BuyWindowEndInputs;
  events: { atMs: number; event: StepDownEvent }[];
};

/** The 2026-10-21 incident's window: 261 A at 55 V in the dark, EDB1 and MUCHGC2610 sent long ago */
export const nightBuying: BuyWindowEndInputs = {
  gridChargingWanted: true,
  acChargingReadback: hecs("enabled", -600_000),
  limitReadback: { amps: 261, observedAtMs: -600_000 },
  lastAboveIdleLimitSentAtMs: -600_000,
  lastAcChargingEnableSentAtMs: -600_000,
  hallBatteryAmps: 280,
  solarWatts: 0,
  batteryVoltage: 55,
};
/** What changes when a window ends: nothing wants grid charging any more */
export const windowEnd: Partial<BuyWindowEndInputs> = { gridChargingWanted: false };
export const COMMIT_AFTER_WRITE_MS = 6_000;
/** #48's post-write radio silence: its confirm readback is decoded this long after a write */
export const QUIET_GAP_AFTER_WRITE_MS = 12_000;
/** From the window-end tick: the cap goes out ~0.5 s later, its confirm a quiet gap after that */
export const CONFIRM_AFTER_WRITE_MS = 500 + QUIET_GAP_AFTER_WRITE_MS;
/** #48's identical-setter gate: the same command string goes out again no sooner than this */
export const IDENTICAL_SETTER_GATE_MS = 60_000;

/** A HECS "AC charge battery" readback observed at `observedAtMs` */
export function hecs(state: AcChargingReading["state"], observedAtMs: number): AcChargingReading {
  return { state, observedAtMs };
}

/** A simulation that has been in this state for a minute of steps, so its history is realistic */
export function buyingFor(inputs: BuyWindowEndInputs): Simulation {
  const simulation: Simulation = { state: initialBuyWindowEndStepDownState(), inputs, events: [] };
  for (let atMs = -60_000; atMs < 0; atMs += 1_000) stepAt(simulation, atMs, {});
  simulation.events = [];
  return simulation;
}

/** A freshly started controller: no readbacks or sends yet, no window, the battery current as the hall sees it */
export function bootedWithHallAt(hallBatteryAmps: number): Simulation {
  return {
    state: initialBuyWindowEndStepDownState(),
    inputs: {
      gridChargingWanted: false,
      acChargingReadback: undefined,
      limitReadback: undefined,
      lastAboveIdleLimitSentAtMs: undefined,
      lastAcChargingEnableSentAtMs: undefined,
      hallBatteryAmps,
      solarWatts: 0,
      batteryVoltage: 55,
    },
    events: [],
  };
}

/** Inputs persist between steps like the signals they stand for; `changes` is what changed at `atMs` */
export function stepAt(simulation: Simulation, atMs: number, changes: Partial<BuyWindowEndInputs>): void {
  simulation.inputs = { ...simulation.inputs, ...changes };
  const { state, events } = stepBuyWindowEndStepDown(simulation.state, simulation.inputs, atMs);
  simulation.state = state;
  for (const event of events) simulation.events.push({ atMs, event });
}

/** Steps at the hall's 4 Hz from `fromMs` to `toMs`; true if AC charging was held on after every step */
export function holdsAtEveryStep(
  simulation: Simulation,
  fromMs: number,
  toMs: number,
  changesAt: (atMs: number) => Partial<BuyWindowEndInputs>
): boolean {
  let heldThroughout = true;
  for (let atMs = fromMs; atMs <= toMs; atMs += 250) {
    stepAt(simulation, atMs, changesAt(atMs));
    if (!holdsAcChargingOn(simulation.state)) heldThroughout = false;
  }
  return heldThroughout;
}

/** Steps at the hall's 4 Hz from `fromMs` to `toMs`; true if AC charging was held on after any step */
export function heldAtAnyStep(
  simulation: Simulation,
  fromMs: number,
  toMs: number,
  changesAt: (atMs: number) => Partial<BuyWindowEndInputs>
): boolean {
  let heldAtSomeStep = false;
  for (let atMs = fromMs; atMs <= toMs; atMs += 250) {
    stepAt(simulation, atMs, changesAt(atMs));
    if (holdsAcChargingOn(simulation.state)) heldAtSomeStep = true;
  }
  return heldAtSomeStep;
}

export function kindsAt(simulation: Simulation, atMs: number): string[] {
  return simulation.events.filter(recorded => recorded.atMs === atMs).map(recorded => recorded.event.kind);
}

export function eventsAfter(simulation: Simulation, afterMs: number): StepDownEvent[] {
  return simulation.events.filter(recorded => recorded.atMs > afterMs).map(recorded => recorded.event);
}

export function lastEvent<Kind extends StepDownEvent["kind"]>(
  simulation: Simulation,
  kind: Kind
): Extract<StepDownEvent, { kind: Kind }> | undefined {
  const matching = simulation.events
    .map(recorded => recorded.event)
    .filter((event): event is Extract<StepDownEvent, { kind: Kind }> => event.kind === kind);
  return matching[matching.length - 1];
}
