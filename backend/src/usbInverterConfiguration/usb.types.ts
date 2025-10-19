import { Accessor, Setter } from "solid-js";

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
   * Query the maximum output power for feeding grid -- queries Query the maximum output power for feeding grid
   */
  | { command: "GPMP" }
  /**
   * Query energy control status -- queries the device energy distribution
   */
  | { command: "HECS" };

export type CommandQueueItem = USBCommands & {
  onSucceeded?: (result: { stdout: string; stderr: string }) => void;
};

export type CommandQueue = Set<CommandQueueItem>;

export type UsbConfiguration = {
  commandQueue: Accessor<CommandQueue>;
  setCommandQueue: Setter<CommandQueue>;
  /**
   * $ indicates this is a reactive store and not a normal object
   */
  $usbValues: UsbValues;
  triggerGettingUsbValues: () => void;
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
}>;
