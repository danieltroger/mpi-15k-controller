/**
 * Consumer-facing types of the inverter comms module (control-write queue items and the settings
 * readback store). Pure — no runtime imports.
 */
import type { SettingsQueryCommandName } from "./pi17Protocol.types.ts";

type InverterSetterCommand =
  // Only the setters the backend currently sends — see the PI17 spec / jblance mpp-solar docs for more
  /**
   * Enable/disable AC charge battery
   */
  | `EDB${0 | 1}`
  /**
   * Enable/disable battery discharge to feed power to utility when solar input normal
   */
  | `EDF${0 | 1}`
  /**
   * Enable/disable battery discharge to feed power to utility when solar input loss
   */
  | `EDG${0 | 1}`
  /**
   * Set max power of feeding grid -- examples: GPMP0nnnnn (n: 0~9, unit: W, 0-15000W for 15KW converter)
   */
  | `GPMP0${string}`
  /**
   * Set maximum charge current from AC -- examples: MUCHGC0600 (current in 4-digit deciamps, 0600 = 60.0 A)
   */
  | `MUCHGC${string}`
  /**
   * Set battery CV (constant/bulk) charge voltage AND float charge voltage atomically -- examples:
   * MCHGV0580,0580 (both values 4-digit decivolts, 58.0 V → 0580; the inverter only accepts 40.0-59.9 V).
   * At 20 bytes this only works over the FTDI serial cable — the inverter's USB-HID port firmware
   * NAKs every command longer than 16 bytes.
   */
  | `MCHGV${string}`;

/**
 * Frame-level outcome of a control write. `acknowledged: false` means the inverter NAKed it
 * (settings unchanged). Timeouts never invoke onResult — the session errorLogs them centrally.
 * Note that even an ACK is not a commit: the inverter applies setters on an internal housekeeping
 * cycle seconds later, which the session verifies via the quiet-gap confirm queries.
 */
export type SetterResult = { acknowledged: boolean };

export type SetterQueueItem = {
  command: InverterSetterCommand;
  /**
   * Any queued-but-unsent setter whose command starts with this prefix is replaced by this item,
   * so a stale target can never be applied after a newer one (e.g. "MCHGV", "GPMP0", "EDB").
   */
  replacesPrefix: string;
  /** Settings queries to run after the post-write quiet gap so the readback stores re-sync; [] = none extra */
  refreshAfterSend: readonly SettingsQueryCommandName[];
  onResult?: (result: SetterResult) => void;
};

export type UsbValues = Partial<{
  maximum_feeding_grid_power: string;
  solar_energy_distribution_priority: string;
  solar_charge_battery: "enabled" | "disabled";
  ac_charge_battery: "enabled" | "disabled";
  feed_power_to_utility: "enabled" | "disabled";
  battery_discharge_to_loads_when_solar_input_normal: "enabled" | "disabled";
  battery_discharge_to_loads_when_solar_input_loss: "enabled" | "disabled";
  battery_discharge_to_feed_grid_when_solar_input_normal: "enabled" | "disabled";
  battery_discharge_to_feed_grid_when_solar_input_loss: "enabled" | "disabled";
  /** The CV/bulk charge voltage from BATS; the "(c.v.)" in the key is verbatim mpp-solar naming */
  "battery_constant_charge_voltage(c.v.)": string;
  battery_floating_charge_voltage: string;
}>;
