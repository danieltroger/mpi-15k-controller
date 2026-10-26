import { type Accessor, createEffect, createMemo, untrack } from "solid-js";
import type { DecodedRound, SettingsQueryCommandName } from "../inverterComms/pi17Protocol.types.ts";
import type { SetterQueueItem, UsbValues } from "../inverterComms/inverterComms.types.ts";
import {
  acChargingLimitReassertions,
  ALTERNATE_CAP_AMPS,
  alternateCapRequests,
  type BuyWindowEndStepDownState,
  holdsAcChargingOn,
  initialBuyWindowEndStepDownState,
  stepBuyWindowEndStepDown,
  wantedAcChargingLimitAmps,
} from "./buyWindowEndStepDown.ts";
import { edb0RetryRequests } from "./buyWindowEndRelease.ts";
import { createAcChargingReadbacks } from "./acChargingReadbacks.ts";
import { logStepDownEvent } from "./buyWindowEndStepDownLog.ts";

/** A hall reading older than this doesn't describe the battery any more (it arrives at ~4 Hz) */
export const HALL_READING_MAX_AGE_MS = 5_000;

/** Everything the buying setters read and write, as plain accessors so a selftest can build the graph */
export type BuyingSetterEnvironment = {
  stillFeedingIn: Accessor<boolean>;
  chargingAmperageForBuying: Accessor<number | undefined>;
  /** The settings store's HECS "AC charge battery" flag */
  acChargeBatteryState: Accessor<UsbValues["ac_charge_battery"]>;
  lastDecodedRound: Accessor<DecodedRound | undefined>;
  /** Hall sensor 2 battery amps (+ = charging) with the wall-clock time of the sample */
  batteryCurrentAmps: Accessor<{ value: number; time: number } | undefined>;
  solarWatts: Accessor<number | undefined>;
  batteryVoltage: Accessor<number | undefined>;
  queueSetter: (item: SetterQueueItem) => void;
  /** The session's record of when each command string last went out, on the monotonic clock */
  lastSentAtMsByCommand: () => Readonly<Record<string, number>>;
  /** When the session last decoded a settings query, on the same clock */
  settingsReadbackAtMs: (query: SettingsQueryCommandName) => number | undefined;
  /** Changes at least every few seconds (useNow), so time-based transitions fire without sensor updates */
  clockTick: Accessor<number>;
  /** The step-down's clock (performance.now() in production) */
  monotonicNowMs: () => number;
  /** For the hall samples' wall-clock timestamps (Date.now() in production) */
  wallClockNowMs: () => number;
};

/**
 * The EDB and MUCHGC setters plus the buy-window end step-down: a window end first caps the charge
 * current at 10 A and holds EDB0 back until that has taken effect — EDB0 at full current is what
 * latched fault 14 three times (#53).
 */
export function wireBuyingSetters(environment: BuyingSetterEnvironment) {
  const { stillFeedingIn, chargingAmperageForBuying, queueSetter } = environment;
  const shouldBuy = createMemo(() => !stillFeedingIn() && !!chargingAmperageForBuying());
  const wantedLimitAmps = createMemo(() => wantedAcChargingLimitAmps(shouldBuy(), chargingAmperageForBuying()));
  const { acChargingLimitReadback, acChargingReading } = createAcChargingReadbacks({
    ...environment,
    sessionAcChargingReadAtMs: () => environment.settingsReadbackAtMs("HECS"),
  });
  // The flag's value only — a new HECS round with the same value must not re-run the EDB effect
  const acChargingState = createMemo(() => acChargingReading()?.state);
  const currentlyBuying = createMemo(() => acChargingState() !== "disabled");

  // The hold must be in force within the very tick a window ends: the EDB effect runs in that tick, and
  // a hold that lags it even by a microtask lets EDB0 out at full current (buyingSetterWiring.selftest.ts
  // pins this). A memo guarantees it — solid recomputes a stale memo when the EDB effect reads it.
  const stepDownState = createMemo<BuyWindowEndStepDownState>(previous => {
    environment.clockTick();
    const { state, events } = stepBuyWindowEndStepDown(
      previous,
      {
        gridChargingWanted: !!chargingAmperageForBuying(),
        // Not reactive, and the session's own object (no copy): read afresh on every evaluation
        sentAtMsByCommand: environment.lastSentAtMsByCommand(),
        acChargingReadback: acChargingReading(),
        limitReadback: acChargingLimitReadback(),
        hallBatteryAmps: freshHallAmps(environment.batteryCurrentAmps(), environment.wallClockNowMs()),
        solarWatts: environment.solarWatts(),
        batteryVoltage: environment.batteryVoltage(),
      },
      environment.monotonicNowMs()
    );
    for (const event of events) logStepDownEvent(event);
    return state;
  }, initialBuyWindowEndStepDownState());
  const holdsAcCharging = createMemo(() => holdsAcChargingOn(stepDownState()));
  const limitReassertions = createMemo(() => acChargingLimitReassertions(stepDownState()));
  const alternateCaps = createMemo(() => alternateCapRequests(stepDownState()));
  const edb0Retries = createMemo(() => edb0RetryRequests(stepDownState()));

  createEffect(() => {
    // Desired state, queued even when the readback already matches: replacesPrefix "EDB" drops any
    // queued-but-unsent opposite command so stale state can't land later, and the session sends
    // nothing when the inverter already holds the wanted value
    const acCharging = acChargingState();
    if (!acCharging) return;
    if (shouldBuy()) {
      queueAcChargingSwitch(queueSetter, "EDB1");
    } else if (holdsAcCharging()) {
      // Withdraws any stale queued EDB0 — but never switches AC charging on just to hold it
      if (acCharging === "enabled") queueAcChargingSwitch(queueSetter, "EDB1");
    } else if (!chargingAmperageForBuying()) {
      queueAcChargingSwitch(queueSetter, "EDB0");
    }
  });

  createEffect(() => queueAcChargingLimit(queueSetter, wantedLimitAmps()));

  // The step-down's bounded re-asks (#48 leaves re-sending a write whose confirm gave up to its owner).
  // Queued only when the count grows: a reset at the phase change must not queue anything.
  createEffect<number>(previousReassertions => {
    const reassertions = limitReassertions();
    if (reassertions > previousReassertions) queueAcChargingLimit(queueSetter, untrack(wantedLimitAmps));
    return reassertions;
  }, 0);
  createEffect<number>(previousRequests => {
    const requests = alternateCaps();
    if (requests > previousRequests) queueAcChargingLimit(queueSetter, ALTERNATE_CAP_AMPS);
    return requests;
  }, 0);
  createEffect<number>(previousRetries => {
    const retries = edb0Retries();
    if (retries > previousRetries) queueAcChargingSwitch(queueSetter, "EDB0");
    return retries;
  }, 0);

  return { currentlyBuying, holdsAcChargingOn: holdsAcCharging, stepDownState };
}

export function freshHallAmps(
  reading: { value: number; time: number } | undefined,
  wallClockNowMs: number
): number | undefined {
  if (!reading || wallClockNowMs - reading.time > HALL_READING_MAX_AGE_MS) return undefined;
  return reading.value;
}

function queueAcChargingSwitch(queueSetter: BuyingSetterEnvironment["queueSetter"], command: "EDB0" | "EDB1") {
  queueSetter({ command, replacesPrefix: "EDB", refreshAfterSend: ["HECS"] });
}

function queueAcChargingLimit(queueSetter: BuyingSetterEnvironment["queueSetter"], amps: number) {
  const targetDeciAmperes = Math.round(amps * 10);
  // replacesPrefix drops any queued-but-unsent AC charging amperage command for this newer target
  queueSetter({
    command: `MUCHGC${(targetDeciAmperes + "").padStart(4, "0")}`,
    replacesPrefix: "MUCHGC",
    refreshAfterSend: [],
  });
}
