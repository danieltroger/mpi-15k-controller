import { catchError, createEffect, createMemo, createResource, createRoot, getOwner } from "solid-js";
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
    const hasCredentials = createMemo(() => !!(config().shinemonitor_password && config().shinemonitor_user));
    const hasInverterDetails = createMemo(() => !!(config().inverter_sn && config().inverter_sn));

    createEffect(() => {
      if (!hasCredentials()) {
        return error(
          "No credentials configured, please set shinemonitor_password and shinemonitor_user in config.json. PREMATURE FLOAT BUG WORKAROUND DISABLED!"
        );
      } else if (!hasInverterDetails()) {
        return error(
          "No inverter details configured, please set inverter_sn and inverter_pn in config.json. PREMATURE FLOAT BUG WORKAROUND DISABLED!"
        );
      }
      prematureFloatBugWorkaround(mqttValues, configResourceValue);
    });
  });
}
