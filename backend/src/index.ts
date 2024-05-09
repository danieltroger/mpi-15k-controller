import { catchError, createEffect, createMemo, createResource, createRoot, createSignal, getOwner } from "solid-js";
import { error } from "./utilities/logging";
import { useMQTTValues } from "./useMQTTValues";
import { prematureFloatBugWorkaround } from "./prematureFloatBugWorkaround";
import { get_config_object } from "./config";
import { wsMessaging } from "./wsMessaging";
import { InfoBroadcast } from "./sharedTypes";
import { wait } from "@depict-ai/utilishared/latest";
import { useTemperatures } from "./useTemperatures";
import { saveTemperatures } from "./saveTemperatures";
import { feedWhenNoSolar } from "./feedWhenNoSolar";
import { useBatteryValues } from "./useBatteryValues";

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
  // TODO: when battery completely empty and essentially disconnected for everything except charging, don't count inverter idle consumption as coming from the battery
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
    const {
      energyDischargedSinceEmpty,
      energyChargedSinceFull,
      energyChargedSinceEmpty,
      energyDischargedSinceFull,
      currentPower,
      totalLastEmpty,
      totalLastFull,
    } = useBatteryValues(mqttValues, configResourceValue);
    // 1000wh = 1000wh were discharged
    // -100wh = 100wh were charged
    const energyRemovedSinceFull = createMemo(() => {
      const discharged = energyDischargedSinceFull();
      const charged = energyChargedSinceFull();
      if (charged == undefined && discharged == undefined) return undefined;
      if (charged == undefined) return Math.abs(discharged!);
      if (discharged == undefined) return Math.abs(charged) * -1;
      return Math.abs(discharged) - Math.abs(charged);
    });
    const temperatures = useTemperatures(config);

    saveTemperatures({ config, mqttClient, temperatures });

    const isChargingOuterScope = createMemo(() => {
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
              isCharging: () => isCharging()?.(),
            }),
          e => {
            setFeedWhenNoSolarErrored(true);
            error("Feed when no solar errored", e, "restarting in 10s");
            setTimeout(() => setFeedWhenNoSolarErrored(false), 10_000);
          }
        );
      });

      return isCharging;
    });
    createResource(() =>
      wsMessaging({
        config_signal: configResourceValue,
        owner,
        temperatures,
        exposedAccessors: {
          mqttValues: () => mqttValues,
          energyDischargedSinceEmpty,
          energyChargedSinceEmpty,
          totalLastEmpty,
          info: () => {
            const broadcast: InfoBroadcast = {
              energyDischargedSinceFull: energyDischargedSinceFull(),
              energyChargedSinceFull: energyChargedSinceFull(),
              totalLastFull: totalLastFull() && new Date(totalLastFull()!).toISOString(),
              energyRemovedSinceFull: energyRemovedSinceFull(),
              currentBatteryPower: currentPower(),
              isCharging: isChargingOuterScope()?.()?.(),
            };
            return broadcast;
          },
        },
      })
    );
  });
}
