import { Accessor, createEffect, createMemo, onCleanup, Setter, untrack } from "solid-js";
import { CommandQueue, CommandQueueItem, UsbValues } from "./usb.types";
import { Config } from "../config/config.types";
import { createStore } from "solid-js/store";
import { debugLog, warnLog } from "../utilities/logging";

const commands = new Set(["GPMP", "HECS"] as const);

const keys = new Set([
  "solar_energy_distribution_priority",
  "solar_charge_battery",
  "ac_charge_battery",
  "feed_power_to_utility",
  "battery_discharge_to_loads_when_solar_input_normal",
  "battery_discharge_to_loads_when_solar_input_loss",
  "battery_discharge_to_feed_grid_when_solar_input_normal",
  "battery_discharge_to_feed_grid_when_solar_input_loss",
  "maximum_feeding_grid_power",
]);

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
  const pollValuesIntervalSeconds = createMemo(() => config().usb_parameter_setting.poll_values_interval_seconds);

  const triggerGettingUsbValues = () => {
    const existingCommandsInQueue = new Set([...untrack(commandQueue)].map(command => command.command));
    const commandsToRun = commands.difference(existingCommandsInQueue);
    for (const command of commandsToRun) {
      const commandQueueItem = {
        command,
        onSucceeded: ({ stdout, stderr }) => {
          if (stderr) {
            warnLog("Got stderr when getting USB values", stderr);
          }
          // Attempt to parse regardless
          const lines = stdout
            .split("\n")
            .map(line => line.trim())
            .filter(line => line);

          for (const line of lines) {
            const [key, value] = line
              .split(" ")
              .map(part => part.trim())
              .filter(v => v);
            if (keys.has(key)) {
              setUsbValues(key as keyof UsbValues, value);
            }
          }
        },
      } satisfies CommandQueueItem;
      setCommandQueue(prev => {
        const newCommandQueue = new Set(prev);
        newCommandQueue.add(commandQueueItem);
        return newCommandQueue;
      });
    }
  };

  triggerGettingUsbValues();

  createEffect(() => debugLog("USB values", JSON.stringify($usbValues, null, 2)));

  createEffect(() => {
    const interval = setInterval(triggerGettingUsbValues, pollValuesIntervalSeconds() * 1000);
    onCleanup(() => clearInterval(interval));
  });

  return { $usbValues, triggerGettingUsbValues };
}
