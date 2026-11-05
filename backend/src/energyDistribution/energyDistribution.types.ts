/**
 * The energy-distribution enforcement as the ws carries it (wsContract.types.ts key `energyDistribution`).
 * Pure types: the frontend imports this file directly.
 */
import type { EnergyDistributionProfile, InverterEnergyDistributionConfig } from "../config/config.types.ts";

/** One enforced HECS field, under its readback name */
export type EnergyDistributionField = keyof EnergyDistributionProfile;

/** Which config profile is in force: the one of the machine model the DM readback shows */
export type EnergyDistributionProfileName = keyof Pick<
  InverterEnergyDistributionConfig,
  "normal_hybrid" | "off_grid_iii"
>;

export type EnergyDistributionFieldDivergence = {
  field: EnergyDistributionField;
  /** What the inverter reads ("Battery-Load-Grid", "disabled", "Unknown key: 03", …), verbatim */
  inverter: string;
  /** What the profile wants */
  desired: string;
};

export type EnergyDistributionFieldState = {
  field: EnergyDistributionField;
  /** The profile's value, or "unmanaged" */
  desired: string;
  /** The latest HECS readback's value; undefined = not read */
  inverter: string | undefined;
};

/** A managed field differing from the profile, from the first readback that showed it until one shows none */
export type EnergyDistributionDivergenceProgress = {
  /** Wall-clock ms the divergence was first seen */
  since: number;
  /**
   * Rounds of setters queued so far: the first, one per change of the DM, the working mode, an enforced HECS
   * field or the profile (up to a cap), and the 10-min fallback
   */
  send_rounds: number;
  /** The change-triggered retries are used up: only the 10-min fallback retries for the rest of the episode */
  fallback_only: boolean;
  /** The P2 for a divergence older than inverter_energy_distribution.p2_after_minutes went out */
  p2_raised: boolean;
};

export type EnergyDistributionStatus = {
  /** The profile in force; undefined = no fresh DM readback of 050 or 151 (nothing is enforced then) */
  profile_name: EnergyDistributionProfileName | undefined;
  /** The DM readback as the inverter sent it; undefined = not read yet */
  machine_model: string | undefined;
  /** Every field of the profile in force (or of normal_hybrid while none is), desired against the inverter */
  fields: EnergyDistributionFieldState[];
  /** Wall-clock ms of the latest HECS readback */
  hecs_read_at: number | undefined;
  /** A managed field differs; undefined = all managed fields read as the profile */
  divergence: EnergyDistributionDivergenceProgress | undefined;
  /**
   * Why nothing goes out right now although a field differs (a pending DM switch, a stale or incomplete
   * readback, the session's identical-setter gate, waiting for a change or the fallback)
   */
  waiting_reason: string | undefined;
  /** The latest thing the enforcement did, and why */
  last_event: { what: string; when: number } | undefined;
};
