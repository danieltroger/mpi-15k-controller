import { Accessor, Setter } from "solid-js";

type USBCommands =
  // Only added the ones I currently need, see jblance mpp-solar documentation for more
  /**
   * Enable/disable AC charge battery
   */
  | { command: "EDB"; value: boolean }
  /**
   * Enable/disable battery discharge to feed power to utility when solar input normal
   */
  | { command: "EDF"; value: boolean }
  /**
   * Enable/disable battery discharge to feed power to utility when solar input loss
   */
  | { command: "EDG"; value: boolean }
  /**
   * Set max power of feeding grid
   */
  | { command: "GPMP0"; value: number }
  /**
   * Query the maximum output power for feeding grid -- queries Query the maximum output power for feeding grid
   */
  | { command: "GPMP" }
  /**
   * Query energy control status -- queries the device energy distribution
   */
  | { command: "HECS" };

export type CommandQueue = (USBCommands & { onResult: (result: string) => void })[];

export type UsbConfiguration = {
  commandQueue: Accessor<CommandQueue>;
  setCommandQueue: Setter<CommandQueue>;
};
