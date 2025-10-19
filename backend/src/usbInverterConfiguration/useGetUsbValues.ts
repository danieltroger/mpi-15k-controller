import { Accessor, createMemo, Setter } from "solid-js";
import { CommandQueue, UsbValues } from "./usb.types";
import { Config } from "../config/config.types";
import { createStore } from "solid-js/store";

const commands = new Set(["GPMP", "HECS"]);

/**
 * Periodically gets the current values via USB
 */
export function useGetUsbValues({
  commandQueue,
  setCommandQueue,
  config,
}: {
  commandQueue: Accessor<CommandQueue>;
  setCommandQueue: Setter<CommandQueue>;
  config: Accessor<Config>;
}) {
  const [$usbValues, setUsbValues] = createStore<UsbValues>({});
  // TODO: polling
  const pollValuesIntervalSeconds = createMemo(() => config().usb_parameter_setting.poll_values_interval_seconds);

  const triggerGettingUsbValues = () => {
    const existingCommandsInQueue = new Set([...commandQueue()].map(command => command.command));
    const commandsToRun = commands.difference(existingCommandsInQueue);
  };

  return { $usbValues, triggerGettingUsbValues };
}
