/**
 * The grid-off switch as the ws carries it (wsContract.types.ts key `gridOff`). Pure types: the frontend
 * imports this file directly.
 */
import type { MachineModelCode } from "../inverterComms/pi17Protocol.types.ts";
import type { NormalEnergyDistribution } from "../config/config.types.ts";

export type GridOffEvent = { what: string; when: number };

export type GridOffStatus = {
  /** What the controller wants the inverter at: 050 unless the page asked for 151 and no guard has reverted it */
  requested_model: MachineModelCode;
  /** Wall-clock ms of the latest request (the page's or a guard's); undefined = 050 since the controller started */
  requested_at: number | undefined;
  /** The DM readback as the inverter sent it ("050", "151", or anything else it reports); undefined = not read yet */
  readback_model: string | undefined;
  /** Wall-clock ms the readback was decoded */
  readback_at: number | undefined;
  /**
   * 151 is requested, or read back and not stuck: the grid relay may be open, so feeding/buying writes hold
   * and the grid alerts stand down
   */
  grid_off_in_force: boolean;
  /** The inverter reads 151 past grid_off.stuck_p1_after_minutes after 050 was wanted (P1 sent; all runs normally) */
  stuck_off_grid: boolean;
  /** The latest thing the switch did or refused, and why */
  last_event: GridOffEvent | undefined;
  /** The HECS settings a DM change resets, and their restore */
  energy_distribution: EnergyDistributionStatus;
};

/** One HECS field the restore puts back, under its readback name */
export type RestorableEnergyDistributionField = keyof NormalEnergyDistribution;

export type EnergyDistributionFieldMismatch = {
  field: RestorableEnergyDistributionField;
  /** What the inverter reads ("Battery-Load-Grid", "disabled", …), verbatim; undefined = missing from the readback */
  live: string | undefined;
  /** What the profile wants */
  wanted: string;
};

/** Where the profile the restore puts back comes from */
export type EnergyDistributionProfileSource =
  /** The HECS read in 050 just before the latest DM151 request; kept until a restore to it lands */
  | "snapshot"
  /** grid_off.normal_energy_distribution */
  | "config";

/** A restore in progress: after a confirmed DM change back to 050, or the page's button */
export type EnergyDistributionRestoreProgress = {
  trigger: "dm_change" | "manual";
  /** Wall-clock ms of the DM readback that showed 050, or of the button press */
  since: number;
  /** Rounds of setters queued so far (resent with back-off while the readback still differs) */
  send_rounds: number;
  /** The P2 for a restore that didn't land within grid_off.settings_restore_p2_after_minutes went out */
  p2_raised: boolean;
};

/** The HECS energy-distribution settings against the profile the controller restores after a DM change */
export type EnergyDistributionStatus = {
  profile: NormalEnergyDistribution;
  profile_source: EnergyDistributionProfileSource;
  /** Wall-clock ms the snapshot was taken (source "snapshot") */
  snapshot_taken_at: number | undefined;
  /** The latest HECS readback against the profile; [] = it matches; undefined = HECS not read yet */
  mismatches: EnergyDistributionFieldMismatch[] | undefined;
  /** Wall-clock ms of that HECS readback */
  hecs_read_at: number | undefined;
  /** undefined = no restore running */
  restore: EnergyDistributionRestoreProgress | undefined;
  /** The latest thing the restore did or refused, and why */
  last_event: GridOffEvent | undefined;
};
