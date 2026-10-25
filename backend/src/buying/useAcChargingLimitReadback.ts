import { type Accessor, createMemo } from "solid-js";
import { useInverterComms } from "../inverterComms/InverterCommsProvider.ts";
import { warnLog } from "../utilities/logging.ts";
import type { AcChargingLimitReadback } from "./buyWindowEndStepDown.ts";

/**
 * "Max. AC charging current" as decoded from BATS — verbatim mpp-solar naming via influxFieldName, the
 * same key the session's MUCHGC confirm (setterConfirmation.ts) checks.
 */
const BATS_AC_CHARGING_LIMIT_FIELD = "max._ac_charging_current";

/**
 * The latest BATS readback of the AC charging limit (the MUCHGC target), from the background settings
 * poll and from the session's post-write confirm — the readback that proves a MUCHGC write committed.
 * Read off the decoded rounds rather than $usbValues so the inverter comms store stays untouched.
 * Stamped with performance.now() when observed: a BATS round reaches its consumers in the batch it
 * was decoded in, and the step-down state machine runs on that monotonic clock.
 */
export function useAcChargingLimitReadback(): Accessor<AcChargingLimitReadback | undefined> {
  const { lastDecodedRound } = useInverterComms();
  return createMemo<AcChargingLimitReadback | undefined>(previous => {
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
    return { amps, observedAtMs: performance.now() };
  }, undefined);
}
