import { type Accessor, createEffect, createMemo, onCleanup, type Setter, untrack } from "solid-js";
import type { CommandQueue, CommandQueueItem, UsbQueryCommandName, UsbValues } from "./usb.types.ts";
import type { Config } from "../config/config.types.ts";
import { createStore } from "solid-js/store";
import { warnLog } from "../utilities/logging.ts";

const commands = new Set(["GPMP", "HECS", "BATS"] as const);

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
  "battery_constant_charge_voltage(c.v.)",
  "battery_floating_charge_voltage",
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

  const triggerGettingUsbValues = (subset?: readonly UsbQueryCommandName[]) => {
    const existingCommandsInQueue = new Set([...untrack(commandQueue)].map(command => command.command));
    const requestedCommands = subset ? new Set(subset) : commands;
    const commandsToRun = requestedCommands.difference(existingCommandsInQueue);
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

          const parsedKeys = new Set<string>();
          for (const line of lines) {
            const [key, value] = line
              .split(" ")
              .map(part => part.trim())
              .filter(v => v);
            if (keys.has(key)) {
              setUsbValues(key as keyof UsbValues, value);
              parsedKeys.add(key);
            }
          }
          // The voltage workaround silently stalls if these stop parsing (a future mpp-solar
          // rewording e.g. adding a space to the "(c.v.)" key would split it into two tokens), so
          // scream rather than go quiet.
          if (command === "BATS") {
            for (const expectedKey of ["battery_constant_charge_voltage(c.v.)", "battery_floating_charge_voltage"]) {
              if (!parsedKeys.has(expectedKey)) {
                warnLog("BATS poll came back without", expectedKey, "- full stdout:", stdout);
              }
            }
          }
        },
        refreshAfterSend: [],
      } satisfies CommandQueueItem;
      setCommandQueue(prev => {
        const newCommandQueue = new Set(prev);
        newCommandQueue.add(commandQueueItem);
        return newCommandQueue;
      });
    }
  };

  triggerGettingUsbValues();

  createEffect(() => {
    const interval = setInterval(triggerGettingUsbValues, pollValuesIntervalSeconds() * 1000);
    onCleanup(() => clearInterval(interval));
  });

  return { $usbValues, triggerGettingUsbValues };
}
