/**
 * Test harness for buyingSetterWiring.ts: builds the real reactive graph under createRoot on plain
 * signals with a simulated clock, so the selftests can drive window ends, readbacks and the hall and
 * see exactly what gets queued in each tick.
 */
import { type Accessor, batch, createRoot, createSignal, type Setter } from "solid-js";
import type { DecodedRound } from "../inverterComms/pi17Protocol.types.ts";
import type { SetterQueueItem, UsbValues } from "../inverterComms/inverterComms.types.ts";
import { wireBuyingSetters } from "./buyingSetterWiring.ts";

/** The simulated wall clock runs this far ahead of the monotonic one, so mixing them up shows */
const WALL_CLOCK_OFFSET_MS = 1_800_000_000_000;

export type SimulatedClock = { monotonicMs: number };

export type WiringHarness = {
  clock: SimulatedClock;
  /** Every command the wiring queued, in order, with the simulated time */
  queued: { atMs: number; command: string }[];
  /** Stands in for the session's send record unless one is passed in (see recordSend) */
  sendRecord: Record<string, number>;
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
    lastSentAtMsByCommand,
  }: {
    clock?: SimulatedClock;
    queueSetter?: (item: SetterQueueItem) => void;
    /** A real (simulated) session's send record; without one, the harness's own sendRecord */
    lastSentAtMsByCommand?: () => Readonly<Record<string, number>>;
  } = {}
): WiringHarness {
  const queued: WiringHarness["queued"] = [];
  const sendRecord: Record<string, number> = {};
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
    const wiring = wireBuyingSetters({
      stillFeedingIn,
      chargingAmperageForBuying,
      acChargeBatteryState,
      lastDecodedRound,
      batteryCurrentAmps,
      solarWatts,
      batteryVoltage: () => 55,
      queueSetter: item => {
        queued.push({ atMs: clock.monotonicMs, command: item.command });
        queueSetter?.(item);
      },
      lastSentAtMsByCommand: lastSentAtMsByCommand ?? (() => sendRecord),
      clockTick,
      monotonicNowMs: () => clock.monotonicMs,
      wallClockNowMs: () => wallClockMs(clock),
    });
    return {
      clock,
      queued,
      sendRecord,
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
    };
  });
}

/** Moves the clock and ticks it, the way useNow's 2 s tick re-evaluates the step-down in production */
export function advanceTo(harness: WiringHarness, atMs: number): void {
  harness.clock.monotonicMs = atMs;
  harness.setClockTick(tick => tick + 1);
}

/** As if the session had just sent `command` (its exchange done now) */
export function recordSend(harness: WiringHarness, command: string): void {
  harness.sendRecord[command] = harness.clock.monotonicMs;
}

/** A fresh hall sample (stamped with the current simulated wall clock) */
export function hallSample(harness: WiringHarness, amps: number): void {
  harness.setBatteryCurrent({ value: amps, time: wallClockMs(harness.clock) });
}

export function decodeBats(harness: WiringHarness, limitAmps: number | string): void {
  harness.setLastDecodedRound({
    command: "BATS",
    fields: { "max._ac_charging_current": limitAmps },
    decodedAt: wallClockMs(harness.clock),
  });
}

/** Like the session: the settings store and the decoded round change in one batch */
export function decodeHecs(harness: WiringHarness, state: "enabled" | "disabled"): void {
  batch(() => {
    harness.setAcChargeBatteryState(state);
    harness.setLastDecodedRound({
      command: "HECS",
      fields: { ac_charge_battery: state },
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
