/**
 * The grid-off switch as the ws carries it (wsContract.types.ts key `gridOff`). Pure types: the frontend
 * imports this file directly.
 */
import type { MachineModelCode } from "../inverterComms/pi17Protocol.types.ts";

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
};

/**
 * Why automatic grid-off wants what it wants (autoGridOffDecisions.ts): "off_grid" is the one that wants 151,
 * every other one keeps the inverter on the grid (050)
 */
export type AutoGridOffReasonKind =
  | "off_grid"
  | "soc_unknown"
  | "window"
  | "battery_full"
  | "battery_above_resume"
  | "battery_low"
  | "short_stretch"
  | "energy_settings"
  | "retry_backoff"
  | "switch_refused";

/** The next switch the schedule says automatic grid-off will make (the SOC may still come first) */
export type AutoGridOffNextSwitch = {
  model: MachineModelCode;
  /** Wall-clock ms */
  at: number;
  /** What it is for, in words: "the buy window at 02:30" */
  why: string;
};

/** Automatic grid-off as the ws carries it (wsContract.types.ts key `gridOffAuto`) */
export type AutoGridOffStatus = {
  /** grid_off.auto_enabled, corrected */
  enabled: boolean;
  /** What it wants the inverter at now; undefined while it is off */
  desired_model: MachineModelCode | undefined;
  reason_kind: AutoGridOffReasonKind | undefined;
  /** Why, in words: "a buy window at 02:30 starts within 10 min", "battery 96 % ≥ 95 % (…)" */
  reason: string | undefined;
  /** Known from the schedule; undefined = none known (it depends on the battery, or nothing is scheduled) */
  next_switch: AutoGridOffNextSwitch | undefined;
};
