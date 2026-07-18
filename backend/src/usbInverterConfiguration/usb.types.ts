import type { Accessor, Setter } from "solid-js";

type USBCommands =
  // Only added the ones I currently need, see jblance mpp-solar documentation for more
  /**
   * Enable/disable AC charge battery
   */
  | { command: `EDB${0 | 1}` }
  /**
   * Enable/disable battery discharge to feed power to utility when solar input normal
   */
  | { command: `EDF${0 | 1}` }
  /**
   * Enable/disable battery discharge to feed power to utility when solar input loss
   */
  | { command: `EDG${0 | 1}` }
  /**
   * Set max power of feeding grid -- examples: GPMP0nnnnn (n: 0~9, unit: W, 0-15000W for 15KW converter)
   */
  | { command: `GPMP0${string}` }
  /**
   * Set maximum charge current from AC -- examples: MUCHGC0600 (Current in mA xxxx)
   */
  | { command: `MUCHGC${string}` }
  /**
   * Set battery CV (constant/bulk) charge voltage AND float charge voltage atomically -- examples:
   * MCHGV0580,0580 (both values 4-digit decivolts, 58.0 V → 0580; mpp-solar only accepts 40.0-59.9 V).
   * At 20 bytes this only works over the FTDI serial cable — the inverter's USB-HID port firmware
   * NAKs every command longer than 16 bytes.
   */
  | { command: `MCHGV${string}` }
  /**
   * Query the maximum output power for feeding grid -- queries Query the maximum output power for feeding grid
   */
  | { command: "GPMP" }
  /**
   * Query energy control status -- queries the device energy distribution
   */
  | { command: "HECS" }
  /**
   * Query battery setting -- charge voltages and charge/discharge current limits
   */
  | { command: "BATS" };

export type UsbQueryCommandName = "GPMP" | "HECS" | "BATS";

export type CommandQueueItem = USBCommands & {
  onSucceeded?: (result: { stdout: string; stderr: string }) => void;
  /** Query commands to re-run (immediately + 10 s later) to confirm this write; [] = none */
  refreshAfterSend: readonly UsbQueryCommandName[];
};

export type CommandQueue = Set<CommandQueueItem>;

export type UsbConfiguration = {
  commandQueue: Accessor<CommandQueue>;
  setCommandQueue: Setter<CommandQueue>;
  /**
   * $ indicates this is a reactive store and not a normal object
   */
  $usbValues: UsbValues;
  triggerGettingUsbValues: (subset?: readonly UsbQueryCommandName[]) => void;
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
  /** The CV/bulk charge voltage from BATS; the "(c.v.)" in the key is verbatim mpp-solar output */
  "battery_constant_charge_voltage(c.v.)": string;
  battery_floating_charge_voltage: string;
}>;
