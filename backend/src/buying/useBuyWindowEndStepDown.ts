import { type Accessor, createMemo } from "solid-js";
import { useInverterComms } from "../inverterComms/InverterCommsProvider.ts";
import { useBatteryValuesProvider } from "../battery/BatteryValuesProvider.ts";
import { reactiveBatteryVoltage } from "../mqttValues/mqttHelpers.ts";
import { useTotalSolarPower } from "../utilities/useTotalSolarPower.ts";
import { useNow } from "../utilities/useNow.ts";
import { logLog, warnLog } from "../utilities/logging.ts";
import {
  type AcChargingLimitReadback,
  type BuyWindowEndInputs,
  type BuyWindowEndStepDownState,
  type StepDownEvent,
  holdsAcChargingOn,
  IDLE_AC_CHARGING_LIMIT_AMPS,
  initialBuyWindowEndStepDownState,
  stepBuyWindowEndStepDown,
} from "./buyWindowEndStepDown.ts";

/** A hall reading older than this doesn't describe the battery any more (it arrives at ~4 Hz) */
const HALL_READING_MAX_AGE_MS = 5_000;

/**
 * Reactive shell around buyWindowEndStepDown.ts: feeds it the readbacks, the hall sensor and PV, logs
 * every step with its timing, and says while AC charging must be held on (EDB0 held back).
 *
 * A memo, not an effect + signal: the EDB effect reads holdsAcChargingOn in the very tick a window
 * ends, and solid recomputes a stale memo on read — an effect-driven signal could still say "not
 * holding" there and let EDB0 out at full current.
 */
export function useBuyWindowEndStepDown({
  chargingAmperageForBuying,
  wantedLimitAmps,
  acChargingLimitReadback,
}: {
  chargingAmperageForBuying: Accessor<number | undefined>;
  wantedLimitAmps: Accessor<number>;
  acChargingLimitReadback: Accessor<AcChargingLimitReadback | undefined>;
}) {
  const { $usbValues } = useInverterComms();
  const { batteryCurrentAmps } = useBatteryValuesProvider();

  const stepDownState = createMemo<BuyWindowEndStepDownState>(previous => {
    // Re-evaluate at least on the 2 s clock too, so the timeout (and the hall-less settle) fire even
    // when no sensor value changes; the hall's ~4 Hz updates drive it the rest of the time
    useNow();
    const inputs: BuyWindowEndInputs = {
      gridChargingWanted: !!chargingAmperageForBuying(),
      wantedLimitAmps: wantedLimitAmps(),
      acChargingReadback: $usbValues.ac_charge_battery,
      limitReadback: acChargingLimitReadback(),
      hallBatteryAmps: freshHallAmps(batteryCurrentAmps()),
      solarWatts: useTotalSolarPower(),
      batteryVoltage: reactiveBatteryVoltage(),
    };
    const { state, events } = stepBuyWindowEndStepDown(previous, inputs, performance.now());
    for (const event of events) logStepDownEvent(event);
    return state;
  }, initialBuyWindowEndStepDownState());

  return { holdsAcChargingOn: createMemo(() => holdsAcChargingOn(stepDownState())) };
}

function freshHallAmps(reading: { value: number; time: number } | undefined): number | undefined {
  if (!reading || Date.now() - reading.time > HALL_READING_MAX_AGE_MS) return undefined;
  return reading.value;
}

function logStepDownEvent(event: StepDownEvent): void {
  const prefix = "Buy-window end step-down:";
  switch (event.kind) {
    case "started":
      return logLog(
        prefix,
        `AC charging is enabled with no buy window wanting it — capping it at ${IDLE_AC_CHARGING_LIMIT_AMPS} A first`,
        `and holding EDB0 back until that has taken effect (limit readback ${formatAmps(event.limitReadbackAmps)},`,
        `hall ${formatAmps(event.hallBatteryAmps)})`
      );
    case "limit_confirmed":
      return logLog(
        prefix,
        `BATS shows the AC charging limit at ${formatAmps(event.limitAmps)} ${formatSeconds(event.afterMs)} in;`,
        `hall ${formatAmps(event.hallBatteryAmps)} (allowed ≤ ${formatAmps(event.allowedHallAmps)})`
      );
    case "released":
      return logLog(
        prefix,
        `hall ${formatAmps(event.hallBatteryAmps)} has stayed ≤ ${formatAmps(event.allowedHallAmps)} for`,
        `${formatSeconds(event.hallSettledForMs)} and the cap was confirmed ${formatSeconds(event.limitConfirmedAfterMs)}`,
        `in — releasing EDB0 ${formatSeconds(event.afterMs)} after the step-down started`
      );
    case "released_without_hall":
      return warnLog(
        prefix,
        "no fresh hall sensor reading — releasing EDB0 on the BATS readback alone (cap confirmed",
        `${formatSeconds(event.limitConfirmedAfterMs)} in), ${formatSeconds(event.afterMs)} after the step-down started`
      );
    case "timed_out":
      return warnLog(
        prefix,
        `the ${IDLE_AC_CHARGING_LIMIT_AMPS} A cap didn't show within ${formatSeconds(event.afterMs)} — sending EDB0 anyway.`,
        `Limit readback ${event.limitReadback ? formatAmps(event.limitReadback.amps) : "none"}`,
        event.limitConfirmedAfterMs === undefined
          ? "(never confirmed),"
          : `(confirmed ${formatSeconds(event.limitConfirmedAfterMs)} in),`,
        `hall ${formatAmps(event.hallBatteryAmps)} (allowed ≤ ${formatAmps(event.allowedHallAmps)})`
      );
    case "cancelled":
      return logLog(prefix, `cancelled ${formatSeconds(event.afterMs)} in: ${event.reason}`);
    case "ac_charging_disabled_confirmed":
      return logLog(
        prefix,
        `HECS shows AC charging disabled ${formatSeconds(event.afterReleaseMs)} after EDB0 was released`,
        `(${formatSeconds(event.afterMs)} after the step-down started)`
      );
    case "release_superseded":
      return logLog(
        prefix,
        `grid charging wanted again ${formatSeconds(event.afterReleaseMs)} after EDB0 was released,`,
        "before HECS showed it applied"
      );
  }
}

function formatAmps(amps: number | undefined): string {
  return amps === undefined ? "unknown" : `${amps.toFixed(1)} A`;
}

function formatSeconds(milliseconds: number): string {
  return `${(milliseconds / 1000).toFixed(1)} s`;
}
