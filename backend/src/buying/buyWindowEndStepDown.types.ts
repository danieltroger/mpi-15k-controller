/**
 * Types of the buy-window end step-down (buyWindowEndStepDown.ts): its inputs, phases and events.
 * Pure — no runtime imports.
 */
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
   * The session's record of when each command string last went out. Only looked up where needed —
   * EDB1 directly, the MUCHGC entries only while stepping down — since it grows with every distinct
   * setter string sent since boot and this runs on every hall sample
   */
  sentAtMsByCommand: Readonly<Record<string, number>>;
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

/** What the latest BATS readback says about the cap */
export type LimitEvidence = "none" | "shows_higher_limit" | "predates_last_higher_limit_write" | "shows_cap";

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
