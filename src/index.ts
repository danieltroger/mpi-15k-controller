import { catchError, createEffect, createMemo, createResource, createRoot, createSignal, getOwner } from "solid-js";
import { error, log } from "./logging";
import { useMQTTValues } from "./useMQTTValues";
import { prematureFloatBugWorkaround } from "./prematureFloatBugWorkaround";
import { get_config_object } from "./config";
import { useEnergySinceRunning } from "./useEnergySinceRunning";
import { useDatabasePower } from "./useDatabasePower";

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
  // TODO: add ws messaging + frontend
  // TODO: add energy integration stuff
  // TODO: consider how much sun is shining in when full current if-statement
  // TODO: limit discharge current as voltage gets lower and limit charge current as voltage gets higher
  const owner = getOwner()!;
  const [configResource] = createResource(() => get_config_object(owner));

  createEffect(() => {
    const configResourceValue = configResource();
    if (!configResourceValue) return;
    const [config] = configResourceValue;
    const mqttValues = useMQTTValues(() => config().mqtt_host);
    const hasCredentials = createMemo(() => !!(config().shinemonitor_password && config().shinemonitor_user));
    const hasInverterDetails = createMemo(() => !!(config().inverter_sn && config().inverter_sn));
    const [prematureWorkaroundErrored, setPrematureWorkaroundErrored] = createSignal(false);
    const energySinceRunning = useEnergySinceRunning(mqttValues, configResourceValue);
    const databasePower = useDatabasePower(configResourceValue);

    createEffect(() => log("Energy since running returned", energySinceRunning()));

    createEffect(() => {
      if (prematureWorkaroundErrored()) return;
      if (!hasCredentials()) {
        return error(
          "No credentials configured, please set shinemonitor_password and shinemonitor_user in config.json. PREMATURE FLOAT BUG WORKAROUND DISABLED!"
        );
      } else if (!hasInverterDetails()) {
        return error(
          "No inverter details configured, please set inverter_sn and inverter_pn in config.json. PREMATURE FLOAT BUG WORKAROUND DISABLED!"
        );
      }
      catchError(
        () => prematureFloatBugWorkaround(mqttValues, configResourceValue),
        e => {
          setPrematureWorkaroundErrored(true);
          error("Premature float bug workaround errored", e, "restarting in 10s");
          setTimeout(() => setPrematureWorkaroundErrored(false), 10_000);
        }
      );
    });
  });
}
