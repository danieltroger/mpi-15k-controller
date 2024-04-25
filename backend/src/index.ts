import { catchError, createEffect, createMemo, createResource, createRoot, createSignal, getOwner } from "solid-js";
import { error } from "./logging";
import { useMQTTValues } from "./useMQTTValues";
import { prematureFloatBugWorkaround } from "./prematureFloatBugWorkaround";
import { get_config_object } from "./config";
import { useCurrentPower } from "./useCurrentPower";
import { useDatabasePower } from "./useDatabasePower";
import { calculateBatteryEnergy } from "./calculateBatteryEnergy";
import { useNow } from "./useNow";
import { wsMessaging } from "./wsMessaging";

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
  // TODO: consider how much sun is shining in when full current if-statement
  // TODO: limit discharge current as voltage gets lower and limit charge current as voltage gets higher
  // TODO: add SOC calculation
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
    const { localPowerHistory, currentPower, lastBatterySeenFullSinceProgramStart } = useCurrentPower(
      mqttValues,
      configResourceValue
    );
    const now = useNow();
    const { databasePowerValues, batteryWasLastFullAtAccordingToDatabase } = useDatabasePower(configResourceValue);
    const totalLastFull = createMemo(() => {
      const lastSinceStart = lastBatterySeenFullSinceProgramStart();
      const lastAccordingToDatabase = batteryWasLastFullAtAccordingToDatabase();
      if (!lastSinceStart && !lastAccordingToDatabase) return;
      if (!lastSinceStart) return lastAccordingToDatabase;
      if (!lastAccordingToDatabase) return lastSinceStart;
      return Math.max(lastSinceStart, lastAccordingToDatabase);
    });
    const { energyDischargedSinceFull, energyChargedSinceFull } = calculateBatteryEnergy({
      localPowerHistory,
      databasePowerValues,
      from: totalLastFull,
      to: now,
    });

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
        () =>
          prematureFloatBugWorkaround({
            mqttValues: mqttValues,
            configSignal: configResourceValue,
            energyDischargedSinceFull,
            energyChargedSinceFull,
          }),
        e => {
          setPrematureWorkaroundErrored(true);
          error("Premature float bug workaround errored", e, "restarting in 10s");
          setTimeout(() => setPrematureWorkaroundErrored(false), 10_000);
        }
      );
    });
    createResource(() =>
      wsMessaging({
        config_signal: configResourceValue,
        owner,
        info: () => ({
          energyDischargedSinceFull: energyDischargedSinceFull(),
          energyChargedSinceFull: energyChargedSinceFull(),
          totalLastFull: totalLastFull() && new Date(totalLastFull()!).toISOString(),
        }),
        mqttValues: () => mqttValues,
      })
    );
  });
}
