import { type Accessor, createMemo } from "solid-js";
import { warnLog } from "../utilities/logging.ts";
import type { DecodedRound } from "../inverterComms/pi17Protocol.types.ts";
import type { UsbValues } from "../inverterComms/inverterComms.types.ts";
import type { AcChargingLimitReadback, AcChargingReading } from "./buyWindowEndStepDown.ts";

/**
 * "Max. AC charging current" as decoded from BATS — verbatim mpp-solar naming via influxFieldName, the
 * same key the session's MUCHGC confirm (setterConfirmation.ts) checks.
 */
const BATS_AC_CHARGING_LIMIT_FIELD = "max._ac_charging_current";
const HECS_AC_CHARGING_FIELD = "ac_charge_battery";

/**
 * The BATS AC charging limit and the HECS "AC charge battery" flag, each stamped with when it was
 * observed — both from the background settings poll and from the session's post-write confirms. Read
 * off the decoded rounds so the inverter comms module stays untouched; stamped on the step-down's
 * monotonic clock in the batch the round was decoded in. The HECS state itself comes from the
 * settings store, which outlives this graph (feedWhenNoSolar restarts after an error): until the next
 * HECS round its time is unknown, -Infinity, i.e. too old to rule anything out.
 */
export function createAcChargingReadbacks({
  lastDecodedRound,
  acChargeBatteryState,
  monotonicNowMs,
}: {
  lastDecodedRound: Accessor<DecodedRound | undefined>;
  acChargeBatteryState: Accessor<UsbValues["ac_charge_battery"]>;
  monotonicNowMs: () => number;
}) {
  const acChargingLimitReadback = createMemo<AcChargingLimitReadback | undefined>(previous => {
    const round = lastDecodedRound();
    if (round?.command !== "BATS") return previous;
    const amps = round.fields[BATS_AC_CHARGING_LIMIT_FIELD];
    if (typeof amps !== "number") {
      // The buy-window step-down would then always run into its timeout — a decode-table drift to fix
      warnLog(
        "BATS round decoded without a numeric",
        BATS_AC_CHARGING_LIMIT_FIELD,
        `(got ${JSON.stringify(amps)}) - decoded fields:`,
        Object.keys(round.fields).join(", ")
      );
      return previous;
    }
    return { amps, observedAtMs: monotonicNowMs() };
  }, undefined);

  const acChargingObservedAtMs = createMemo<number | undefined>(previous => {
    const round = lastDecodedRound();
    if (round?.command !== "HECS") return previous;
    return typeof round.fields[HECS_AC_CHARGING_FIELD] === "string" ? monotonicNowMs() : previous;
  }, undefined);

  const acChargingReading = createMemo<AcChargingReading | undefined>(() => {
    const state = acChargeBatteryState();
    if (!state) return undefined;
    return { state, observedAtMs: acChargingObservedAtMs() ?? -Infinity };
  });

  return { acChargingLimitReadback, acChargingReading };
}
