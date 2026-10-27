/**
 * Test harness for buyingSetterWiring.ts: builds the real reactive graph under createRoot on plain
 * signals with a simulated clock, so the selftests can drive window ends, readbacks and the hall and
 * see exactly what gets queued in each tick. Unless a (simulated) session is passed in, the harness
 * keeps the session's write chains itself, with the real scheduler functions: recordSend and the
 * decodes feed them like the session's sends and readbacks.
 */
import { type Accessor, batch, createRoot, createSignal, type Setter } from "solid-js";
import type { DecodedRound, SettingsQueryCommandName } from "../inverterComms/pi17Protocol.types.ts";
import type { SetterQueueItem, UsbValues } from "../inverterComms/inverterComms.types.ts";
import { type FieldWrite, unprovenWritesIn } from "../inverterComms/fieldWriteChains.ts";
import {
  afterSetterSent,
  initialSchedulerState,
  type SchedulerState,
  withSettingsReadbackRequested,
  withSettingsReadback,
} from "../inverterComms/schedulerCore.ts";
import { wireBuyingSetters } from "./buyingSetterWiring.ts";
import {
  DEFAULT_SETTER_CHANGE_THROTTLE_SETTINGS,
  type SetterChangeThrottleSettings,
} from "../inverterComms/setterChangeThrottle.ts";

/** The simulated wall clock runs this far ahead of the monotonic one, so mixing them up shows */
const WALL_CLOCK_OFFSET_MS = 1_800_000_000_000;

export type SimulatedClock = { monotonicMs: number };

export type WiringHarness = {
  clock: SimulatedClock;
  /** Every command the wiring queued, in order, with the simulated time */
  queued: { atMs: number; command: string; item: SetterQueueItem }[];
  /** When the wiring asked the session for a settings readback */
  readbackRequestsAtMs: number[];
  /** Stands in for the session's write chains unless a session is passed in (see recordSend) */
  scheduler: SchedulerState;
  wiring: ReturnType<typeof wireBuyingSetters>;
  dispose: () => void;
  setChargingAmperage: Setter<number | undefined>;
  setStillFeedingIn: Setter<boolean>;
  setAcChargeBatteryState: Setter<UsbValues["ac_charge_battery"]>;
  setLastDecodedRound: Setter<DecodedRound | undefined>;
  setBatteryCurrent: Setter<{ value: number; time: number } | undefined>;
  setSolarWatts: Setter<number | undefined>;
  setClockTick: Setter<number>;
  clockTick: Accessor<number>;
  /** The write-throttle knobs as the config page would change them (the defaults to start with) */
  setSetterChangeThrottle: Setter<SetterChangeThrottleSettings>;
};

export type WiringHarnessStart = {
  chargingAmperageForBuying: number | undefined;
  acChargeBatteryState: UsbValues["ac_charge_battery"];
  hallBatteryAmps: number | undefined;
  solarWatts?: number;
};

export function createWiringHarness(
  start: WiringHarnessStart,
  {
    clock = { monotonicMs: 0 },
    queueSetter,
    unprovenWrites,
    requestSettingsReadback,
    settingsReadbackAtMs = () => undefined,
  }: {
    clock?: SimulatedClock;
    queueSetter?: (item: SetterQueueItem) => void;
    /** A real (simulated) session's readback request; without one, the harness records it in its own scheduler */
    requestSettingsReadback?: (query: SettingsQueryCommandName) => void;
    /** A real (simulated) session's write chains; without one, the harness's own (see recordSend) */
    unprovenWrites?: (query: SettingsQueryCommandName, field: string) => readonly FieldWrite[];
    /** The session's settings-decode times; without one, none (a HECS of unknown age) */
    settingsReadbackAtMs?: (query: SettingsQueryCommandName) => number | undefined;
  } = {}
): WiringHarness {
  const queued: WiringHarness["queued"] = [];
  const readbackRequestsAtMs: number[] = [];
  return createRoot(dispose => {
    const [chargingAmperageForBuying, setChargingAmperage] = createSignal(start.chargingAmperageForBuying);
    const [stillFeedingIn, setStillFeedingIn] = createSignal(false);
    const [acChargeBatteryState, setAcChargeBatteryState] = createSignal(start.acChargeBatteryState);
    const [lastDecodedRound, setLastDecodedRound] = createSignal<DecodedRound | undefined>(undefined);
    const [batteryCurrentAmps, setBatteryCurrent] = createSignal(
      start.hallBatteryAmps === undefined ? undefined : { value: start.hallBatteryAmps, time: wallClockMs(clock) }
    );
    const [solarWatts, setSolarWatts] = createSignal<number | undefined>(start.solarWatts ?? 0);
    const [clockTick, setClockTick] = createSignal(0);
    const [setterChangeThrottle, setSetterChangeThrottle] = createSignal(DEFAULT_SETTER_CHANGE_THROTTLE_SETTINGS);
    const harness = { scheduler: initialSchedulerState() };
    const wiring = wireBuyingSetters({
      stillFeedingIn,
      chargingAmperageForBuying,
      acChargeBatteryState,
      lastDecodedRound,
      batteryCurrentAmps,
      solarWatts,
      batteryVoltage: () => 55,
      queueSetter: item => {
        queued.push({ atMs: clock.monotonicMs, command: item.command, item });
        queueSetter?.(item);
      },
      unprovenWrites:
        unprovenWrites ?? ((query, field) => unprovenWritesIn(harness.scheduler.dropTrustChains, query, field)),
      requestSettingsReadback: query => {
        readbackRequestsAtMs.push(clock.monotonicMs);
        if (requestSettingsReadback) requestSettingsReadback(query);
        else harness.scheduler = withSettingsReadbackRequested(harness.scheduler, query, clock.monotonicMs);
      },
      settingsReadbackAtMs,
      clockTick,
      monotonicNowMs: () => clock.monotonicMs,
      wallClockNowMs: () => wallClockMs(clock),
      setterChangeThrottle,
    });
    return Object.assign(harness, {
      clock,
      queued,
      readbackRequestsAtMs,
      wiring,
      dispose,
      setChargingAmperage,
      setStillFeedingIn,
      setAcChargeBatteryState,
      setLastDecodedRound,
      setBatteryCurrent,
      setSolarWatts,
      setClockTick,
      clockTick,
      setSetterChangeThrottle,
    });
  });
}

/** Moves the clock and ticks it, the way useNow's 2 s tick re-evaluates the step-down in production */
export function advanceTo(harness: WiringHarness, atMs: number): void {
  harness.clock.monotonicMs = atMs;
  harness.setClockTick(tick => tick + 1);
}

/** As if the session had just sent `command` (its exchange done now): its writes join the chains */
export function recordSend(harness: WiringHarness, command: string): void {
  harness.scheduler = afterSetterSent(harness.scheduler, command, [], harness.clock.monotonicMs, true);
}

/** A fresh hall sample (stamped with the current simulated wall clock) */
export function hallSample(harness: WiringHarness, amps: number): void {
  harness.setBatteryCurrent({ value: amps, time: wallClockMs(harness.clock) });
}

/** Like the session: the readback is credited to the write chains before the graph sees it */
export function decodeBats(harness: WiringHarness, limitAmps: number | string): void {
  const fields = { "max._ac_charging_current": limitAmps };
  harness.scheduler = withSettingsReadback(harness.scheduler, "BATS", fields, harness.clock.monotonicMs);
  harness.setLastDecodedRound({ command: "BATS", wireCommand: "BATS", fields, decodedAt: wallClockMs(harness.clock) });
}

/** Like the session: credited to the chains, then the settings store and the decoded round change in one batch */
export function decodeHecs(harness: WiringHarness, state: "enabled" | "disabled"): void {
  const fields = { ac_charge_battery: state };
  harness.scheduler = withSettingsReadback(harness.scheduler, "HECS", fields, harness.clock.monotonicMs);
  batch(() => {
    harness.setAcChargeBatteryState(state);
    harness.setLastDecodedRound({
      command: "HECS",
      wireCommand: "HECS",
      fields,
      decodedAt: wallClockMs(harness.clock),
    });
  });
}

/** The commands queued while `action` ran — i.e. in that reactive tick */
export function queuedDuring(harness: WiringHarness, action: () => void): string[] {
  const before = harness.queued.length;
  action();
  return harness.queued.slice(before).map(entry => entry.command);
}

/** Steps the clock at the hall's 4 Hz with fresh samples of `hallAmpsAt(atMs)`; returns what got queued */
export function runWithHall(
  harness: WiringHarness,
  fromMs: number,
  toMs: number,
  hallAmpsAt: (atMs: number) => number
): { atMs: number; command: string }[] {
  const before = harness.queued.length;
  for (let atMs = fromMs; atMs <= toMs; atMs += 250) {
    advanceTo(harness, atMs);
    hallSample(harness, hallAmpsAt(atMs));
  }
  return harness.queued.slice(before);
}

export function wallClockMs(clock: SimulatedClock): number {
  return WALL_CLOCK_OFFSET_MS + clock.monotonicMs;
}
