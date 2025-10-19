import { debugLog, errorLog } from "../utilities/logging";
import { exec } from "../utilities/exec";
import { Accessor, createEffect, createMemo, createResource, createSignal, untrack } from "solid-js";
import { CommandQueueItem } from "./usb.types";
import { Config } from "../config/config.types";
import { useUsbInverterConfiguration } from "./UsbInverterConfigurationProvider";

export function useHandleUsbQueue(config: Accessor<Config>) {
  const { commandQueue } = useUsbInverterConfiguration();
  const [blockChecking, setBlockChecking] = createSignal(false);
  const hasQueueItem = createMemo(() => !!commandQueue().size);

  createEffect(() => {
    if (!hasQueueItem() || blockChecking()) return;
    createResource(async () => {
      try {
        // Intentionally don't depend on any specific queue item in here and do other stuff to handle the case of commands being added to the queue while we're already processing the queue (and handling them directly)
        await sendUsbCommands();
        setBlockChecking(true);
        setTimeout(
          () => setBlockChecking(false),
          untrack(() => config().usb_parameter_setting.min_seconds_between_commands) * 1000
        );
      } catch (e) {
        errorLog("Failed to send USB commands", e);
      }
    });
  });
}

async function sendUsbCommands() {
  const { commandQueue, setCommandQueue } = useUsbInverterConfiguration();
  debugLog("Turning off MQTT value reading daemon");
  const { stdout: disableStdout, stderr: disableStderr } = await exec("systemctl --user stop mpp-solar");
  debugLog("Turned off MQTT value reading daemon", { disableStdout, disableStderr });

  // Allow things to be added to the queue while we're processing it
  while (untrack(commandQueue).size > 0) {
    let queueItem: CommandQueueItem;
    // Get first command in queue, and instantly update the queue
    setCommandQueue(prev => {
      const newQueue = new Set(prev);
      for (const item of newQueue) {
        newQueue.delete(item);
        queueItem = item;
      }
      return newQueue;
    });

    debugLog("Sending USB command", queueItem!);
    try {
      const { stdout, stderr } = await exec(`mpp-solar -p /dev/hidraw0 -P PI17  -c ${queueItem!.command}`);
      queueItem!.onSucceeded({ stdout, stderr });
    } catch (e) {
      errorLog("Failed to send USB command", queueItem!, e);
      queueItem!.onFailed(e);
    }
  }

  debugLog("Turning on MQTT value reading daemon");
  const { stdout: enableStdout, stderr: enableStderr } = await exec("systemctl --user start mpp-solar");
  debugLog("Turned on MQTT value reading daemon", { enableStdout, enableStderr });
}
