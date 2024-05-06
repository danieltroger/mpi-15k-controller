import { catchError, createEffect, createMemo, createResource, createRoot, createSignal, getOwner } from "solid-js";
import { error } from "./utilities/logging";
import { useMQTTValues } from "./useMQTTValues";
import { prematureFloatBugWorkaround } from "./prematureFloatBugWorkaround";
import { get_config_object } from "./config";
import { useCurrentPower } from "./useCurrentPower";
import { useDatabasePower } from "./useDatabasePower";
import { calculateBatteryEnergy } from "./calculateBatteryEnergy";
import { useNow } from "./utilities/useNow";
import { wsMessaging } from "./wsMessaging";
import { InfoBroadcast } from "./sharedTypes";
import { wait } from "@depict-ai/utilishared/latest";
import { useTemperatures } from "./useTemperatures";
import { saveTemperatures } from "./saveTemperatures";
import { feedWhenNoSolar } from "./feedWhenNoSolar";

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
  await wait(10000);
}

function main() {
  // TODO: consider how much sun is shining in when full current if-statement
  // TODO: limit discharge current as voltage gets lower and limit charge current as voltage gets higher
  // TODO: improve/finish SOC calculation
  // TODO: Alerts when battery overheats / program restarts
  // TODO: add typecheck CI pipeline
  // TODO: Send SOC in mqtt
  // TODO: disallow shouldEnableFeeding from changing often in short amount of time
  const owner = getOwner()!;
  const [configResource] = createResource(() => get_config_object(owner));

  createEffect(() => {
    const configResourceValue = configResource();
    if (!configResourceValue) return;
    const [config] = configResourceValue;
    const { mqttValues, mqttClient } = useMQTTValues(createMemo(() => config().mqtt_host));
    const hasCredentials = createMemo(() => !!(config().shinemonitor_password && config().shinemonitor_user));
    const hasInverterDetails = createMemo(() => !!(config().inverter_sn && config().inverter_sn));
    const [prematureWorkaroundErrored, setPrematureWorkaroundErrored] = createSignal(false);
    const [feedWhenNoSolarErrored, setFeedWhenNoSolarErrored] = createSignal(false);
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
      config,
    });
    // 1000wh = 1000wh were discharged
    // -100wh = 100wh were charged
    const energyRemovedSinceFull = createMemo(() => {
      const discharged = energyDischargedSinceFull();
      const charged = energyChargedSinceFull();
      if (charged == undefined && discharged == undefined) return 0;
      if (charged == undefined) return Math.abs(discharged!);
      if (discharged == undefined) return Math.abs(charged);
      return Math.abs(discharged) - Math.abs(charged);
    });
    const temperatures = useTemperatures(config);

    saveTemperatures({ config, mqttClient, temperatures });

    createEffect(() => {
      if (!hasCredentials()) {
        return error(
          "No credentials configured, please set shinemonitor_password and shinemonitor_user in config.json. PREMATURE FLOAT BUG WORKAROUND (and feed when no solar) DISABLED!"
        );
      } else if (!hasInverterDetails()) {
        return error(
          "No inverter details configured, please set inverter_sn and inverter_pn in config.json. PREMATURE FLOAT BUG WORKAROUND (and feed when no solar) DISABLED!"
        );
      }
      const isCharging = createMemo(() => {
        if (prematureWorkaroundErrored()) return;
        return catchError(
          () =>
            prematureFloatBugWorkaround({
              mqttValues,
              configSignal: configResourceValue,
              energyRemovedSinceFull,
            }),
          e => {
            setPrematureWorkaroundErrored(true);
            error("Premature float bug workaround errored", e, "restarting in 10s");
            setTimeout(() => setPrematureWorkaroundErrored(false), 10_000);
          }
        );
      });

      createEffect(() => {
        if (feedWhenNoSolarErrored()) return;
        catchError(
          () =>
            feedWhenNoSolar({
              mqttValues: mqttValues,
              configSignal: configResourceValue,
              currentBatteryPower: currentPower,
              isCharging: () => isCharging()?.(),
            }),
          e => {
            setFeedWhenNoSolarErrored(true);
            error("Feed when no solar errored", e, "restarting in 10s");
            setTimeout(() => setFeedWhenNoSolarErrored(false), 10_000);
          }
        );
      });
    });
    createResource(() =>
      wsMessaging({
        config_signal: configResourceValue,
        owner,
        info: () => {
          const broadcast: InfoBroadcast = {
            energyDischargedSinceFull: energyDischargedSinceFull(),
            energyChargedSinceFull: energyChargedSinceFull(),
            totalLastFull: totalLastFull() && new Date(totalLastFull()!).toISOString(),
            energyRemovedSinceFull: energyRemovedSinceFull(),
            currentBatteryPower: currentPower(),
          };
          return broadcast;
        },
        mqttValues: () => mqttValues,
        temperatures,
      })
    );
  });
}
