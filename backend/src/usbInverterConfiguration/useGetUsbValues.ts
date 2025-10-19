import { Accessor, createMemo, Setter } from "solid-js";
import { CommandQueue } from "./usb.types";
import { Config } from "../config/config.types";

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
  const pollValuesIntervalSeconds = createMemo(() => config().usb_parameter_setting.poll_values_interval_seconds);
}
