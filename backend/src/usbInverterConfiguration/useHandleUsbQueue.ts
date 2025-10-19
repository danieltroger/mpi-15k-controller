import { debugLog, errorLog } from "../utilities/logging";
import { exec } from "../utilities/exec";
import { Accessor, createEffect, createMemo, createResource, createSignal, untrack } from "solid-js";
import { CommandQueueItem } from "./usb.types";
import { Config } from "../config/config.types";
import { useUsbInverterConfiguration } from "./UsbInverterConfigurationProvider";

export function useHandleUsbQueue(config: Accessor<Config>) {
  const { commandQueue } = useUsbInverterConfiguration();
  const [blockProcessQueue, setBlockProcessQueue] = createSignal(false);
  const hasQueueItem = createMemo(() => !!commandQueue().size);

  createEffect(() => {
    if (!hasQueueItem() || blockProcessQueue()) return;
    createResource(async () => {
      try {
        setBlockProcessQueue(true);
        // Intentionally don't depend on any specific queue item in here and do other stuff to handle the case of commands being added to the queue while we're already processing the queue (and handling them directly)
        await sendUsbCommands();
        setTimeout(
          () => setBlockProcessQueue(false),
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

  // Get the user's runtime directory and UID for systemctl --user to work
  if (!process.getuid) {
    throw new Error("process.getuid is not available - this system may not support systemctl --user");
  }
  const uid = process.getuid();
  const xdgRuntimeDir = `/run/user/${uid}`;
  const dbusSessionBusAddress = `unix:path=${xdgRuntimeDir}/bus`;
  const env = {
    ...process.env,
    XDG_RUNTIME_DIR: xdgRuntimeDir,
    DBUS_SESSION_BUS_ADDRESS: dbusSessionBusAddress,
  };

  const { stdout: disableStdout, stderr: disableStderr } = await exec("systemctl --user stop mpp-solar", { env });
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
        return newQueue;
      }
      return newQueue;
    });

    debugLog("Sending USB command", queueItem!);
    try {
      const { stdout, stderr } = await exec(
        `/home/ubuntu/mpp-solar/.venv/bin/mpp-solar -p /dev/hidraw0 -P PI17  -c ${queueItem!.command}`
      );
      queueItem!.onSucceeded?.({ stdout, stderr });
      debugLog("Succeded running USB command", queueItem!, { stdout, stderr });
    } catch (e) {
      errorLog("Failed to send USB command", queueItem!, e);
    }
  }

  debugLog("Turning on MQTT value reading daemon");
  const { stdout: enableStdout, stderr: enableStderr } = await exec("systemctl --user start mpp-solar", { env });
  debugLog("Turned on MQTT value reading daemon", { enableStdout, enableStderr });
}
