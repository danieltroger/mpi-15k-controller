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
  /** 151 is requested or read back: the grid relay may be open, so feeding/buying writes hold and grid alerts stand down */
  grid_off_in_force: boolean;
  /** The latest thing the switch did or refused, and why */
  last_event: GridOffEvent | undefined;
};
