/**
 * Types of the buy-window end step-down (buyWindowEndStepDown.ts): its inputs, phases and events.
 * Pure — no runtime imports.
 */
import type { FieldWrite } from "../inverterComms/fieldWriteChains.ts";

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
  /**
   * The session's writes to that limit (MUCHGC) no readback has proven landed yet, oldest first, values in
   * amps — #62's per-field write chain with the drop-trust window (fieldWriteChains.ts, schedulerTiming.ts)
   */
  unprovenLimitWrites: readonly FieldWrite[];
  /** The same for the HECS "AC charge battery" flag (EDB1/EDB0), values "enabled"/"disabled" */
  unprovenAcChargingWrites: readonly FieldWrite[];
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
  /**
   * Times the alternate cap was asked for: once to settle a readback that can't tell whether a higher
   * write landed (A→B→A), once more when the hold is extended
   */
  alternateCapRequests: number;
  /** Times the session was asked for a fresh settings readback (buyWindowEndAsks.ts), and the last time */
  readbackRequests: number;
  lastReadbackRequestAtMs: number | undefined;
  /** When EDB0 goes out regardless: the timeout, pushed out once by STEP_DOWN_EXTENSION_MS */
  deadlineMs: number;
  /** The hold was extended — which also asks for the alternate cap */
  extended: boolean;
};

/** EDB0 is allowed; waiting for a HECS readback newer than the release to show it (buyWindowEndRelease.ts) */
export type Released = {
  phase: "released";
  startedAtMs: number;
  releasedAtMs: number;
  edb0Retries: number;
  lastEdb0RequestAtMs: number;
  edb0RetriesExhausted: boolean;
};

export type StepDownProgress = { phase: "idle" } | SteppingDown | Released;

export type BuyWindowEndStepDownState = { progress: StepDownProgress };

/**
 * What the latest BATS readback says about the cap: "higher_limit_unproven" shows it, but a write above it
 * that no readback has proven landed may still commit
 */
export type LimitEvidence = "none" | "shows_higher_limit" | "higher_limit_unproven" | "shows_cap";

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
      kind: "ambiguous_limit_readback";
      afterMs: number;
      limitReadbackAmps: number;
      /** The unproven writes above the idle cap that the readback can't rule out */
      unprovenHigherLimitsAmps: number[];
    }
  | {
      kind: "readback_requested";
      afterMs: number;
      limitEvidence: LimitEvidence;
      limitReadbackAmps: number | undefined;
      hallSettledForMs: number;
      attempt: number;
    }
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
      /** How long the hall has stayed within the allowance (undefined: it isn't, or there is no reading) */
      hallSettledForMs: number | undefined;
      /** A write above the cap that no readback has proven landed may still commit */
      higherLimitMayLand: boolean;
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
