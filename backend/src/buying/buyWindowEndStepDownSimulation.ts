/**
 * Test harness for the buy-window end step-down selftests: drives the pure state machine through
 * timelines of input changes. Timelines follow the native PI17 session: a write commits ~6 s after it
 * goes out, its BATS confirm is decoded 9–12 s after it and re-read every few seconds while still old,
 * and an identical setter is re-sent no sooner than 60 s after the last one. Most timelines put the
 * confirm at 12 s (#48's retired quiet gap); the early-readback ones read BATS 6–9 s after a write, as a
 * settings poll or another write's confirm can. The state machine judges a readback by its time against
 * the write chains, not by when a confirm was due, so both are placements it must get right. The
 * session's write chains come from the real scheduler: sentAt, batsAt and hecsAt feed it exactly as the
 * session's sends and decodes do, and hand the step-down the drop-trust chains the session exposes.
 */
import { unprovenWritesIn } from "../inverterComms/fieldWriteChains.ts";
import {
  afterSetterSent,
  initialSchedulerState,
  type SchedulerState,
  withSettingsReadback,
} from "../inverterComms/schedulerCore.ts";
import { BATS_AC_CHARGING_LIMIT_FIELD, HECS_AC_CHARGING_FIELD } from "./acChargingReadbacks.ts";
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
  /** The session's scheduler — here only for its write chains, fed by sentAt / batsAt / hecsAt */
  scheduler: SchedulerState;
  events: { atMs: number; event: StepDownEvent }[];
};

/** The 2026-10-21 incident's window: 261 A at 55 V in the dark, EDB1 and MUCHGC2610 sent and read back long ago */
export const nightBuying: BuyWindowEndInputs = {
  gridChargingWanted: true,
  acChargingReadback: hecs("enabled", -600_000),
  limitReadback: { amps: 261, observedAtMs: -600_000 },
  unprovenLimitWrites: [],
  unprovenAcChargingWrites: [],
  hallBatteryAmps: 280,
  solarWatts: 0,
  batteryVoltage: 55,
};
/** What changes when a window ends: nothing wants grid charging any more */
export const windowEnd: Partial<BuyWindowEndInputs> = { gridChargingWanted: false };
export const COMMIT_AFTER_WRITE_MS = 6_000;
/** Where the timelines decode a write's confirm readback: 12 s after it */
export const LATE_CONFIRM_AFTER_WRITE_MS = 12_000;
/** The window-end tick queues the cap; the session's exchange of it is done this much later */
export const CAP_SENT_AFTER_END_MS = 500;
/** From the window-end tick: the cap goes out ~0.5 s later, its confirm 12 s after that */
export const CONFIRM_AFTER_WRITE_MS = CAP_SENT_AFTER_END_MS + LATE_CONFIRM_AFTER_WRITE_MS;
/** #48's identical-setter gate: the same command string goes out again no sooner than this */
export const IDENTICAL_SETTER_GATE_MS = 60_000;

/** The session finishing a send of `command` at `atMs`: its writes join the chains. Returns the input change. */
export function sentAt(simulation: Simulation, command: string, atMs: number): Partial<BuyWindowEndInputs> {
  simulation.scheduler = afterSetterSent(simulation.scheduler, command, [], atMs, true);
  return unprovenWritesOf(simulation.scheduler);
}

/** A BATS limit readback decoded at `atMs`, credited to the chains before the step-down sees it */
export function batsAt(simulation: Simulation, amps: number, atMs: number): Partial<BuyWindowEndInputs> {
  simulation.scheduler = withSettingsReadback(
    simulation.scheduler,
    "BATS",
    { [BATS_AC_CHARGING_LIMIT_FIELD]: amps },
    atMs
  );
  return { limitReadback: { amps, observedAtMs: atMs }, ...unprovenWritesOf(simulation.scheduler) };
}

/** A HECS "AC charge battery" readback decoded at `atMs`, credited the same way */
export function hecsAt(
  simulation: Simulation,
  state: AcChargingReading["state"],
  atMs: number
): Partial<BuyWindowEndInputs> {
  simulation.scheduler = withSettingsReadback(simulation.scheduler, "HECS", { [HECS_AC_CHARGING_FIELD]: state }, atMs);
  return { acChargingReadback: hecs(state, atMs), ...unprovenWritesOf(simulation.scheduler) };
}

/** A HECS reading as the step-down sees it, with no chain behind it (for the released phase on its own) */
export function hecs(state: AcChargingReading["state"], observedAtMs: number): AcChargingReading {
  return { state, observedAtMs };
}

/** The window ends at 0; the session sends the cap (its exchange done) CAP_SENT_AFTER_END_MS later */
export function endWindow(simulation: Simulation): void {
  stepAt(simulation, 0, windowEnd);
  stepAt(simulation, CAP_SENT_AFTER_END_MS, sentAt(simulation, "MUCHGC0100", CAP_SENT_AFTER_END_MS));
}

/**
 * A simulation that has been in this state for a minute of steps (to -10 s, leaving room for sends just
 * before a window end), the session holding `inputs`' readbacks with nothing unproven
 */
export function buyingFor(inputs: BuyWindowEndInputs): Simulation {
  let scheduler = initialSchedulerState();
  if (inputs.limitReadback) {
    const { amps, observedAtMs } = inputs.limitReadback;
    scheduler = withSettingsReadback(scheduler, "BATS", { [BATS_AC_CHARGING_LIMIT_FIELD]: amps }, observedAtMs);
  }
  if (inputs.acChargingReadback) {
    const { state, observedAtMs } = inputs.acChargingReadback;
    scheduler = withSettingsReadback(scheduler, "HECS", { [HECS_AC_CHARGING_FIELD]: state }, observedAtMs);
  }
  const simulation: Simulation = { state: initialBuyWindowEndStepDownState(), inputs, scheduler, events: [] };
  for (let atMs = -60_000; atMs <= -10_000; atMs += 1_000) stepAt(simulation, atMs, {});
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
      unprovenLimitWrites: [],
      unprovenAcChargingWrites: [],
      hallBatteryAmps,
      solarWatts: 0,
      batteryVoltage: 55,
    },
    scheduler: initialSchedulerState(),
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

function unprovenWritesOf(
  scheduler: SchedulerState
): Pick<BuyWindowEndInputs, "unprovenLimitWrites" | "unprovenAcChargingWrites"> {
  return {
    unprovenLimitWrites: unprovenWritesIn(scheduler.dropTrustChains, "BATS", BATS_AC_CHARGING_LIMIT_FIELD),
    unprovenAcChargingWrites: unprovenWritesIn(scheduler.dropTrustChains, "HECS", HECS_AC_CHARGING_FIELD),
  };
}
