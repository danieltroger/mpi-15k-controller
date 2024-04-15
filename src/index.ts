import { catchError, createEffect, createResource, createRoot, getOwner } from "solid-js";
import { error } from "./logging";
import { useMQTTValues } from "./useMQTTValues";
import { prematureFloatBugWorkaround } from "./prematureFloatBugWorkaround";
import { get_config_object } from "./config";

while (true) {
  await new Promise<void>(r => {
    createRoot(dispose => {
      catchError(main, e => {
        error("Main crashed, restarting in 10s", e);
        dispose();
        r();
      });
    });
  });
  await new Promise(r => setTimeout(r, 10000));
}

function main() {
  const owner = getOwner()!;
  const [configResource] = createResource(() => get_config_object(owner));

  createEffect(() => {
    const configResourceValue = configResource();
    if (!configResourceValue) return;
    const [config] = configResourceValue;
    const mqttValues = useMQTTValues();

    prematureFloatBugWorkaround(mqttValues, config);
  });
}
