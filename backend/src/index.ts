import { catchError, createEffect, createMemo, createResource, createRoot, createSignal, getOwner } from "solid-js";
import { error } from "./utilities/logging";
import { useMQTTValues } from "./useMQTTValues";
import { get_config_object } from "./config";
import { wsMessaging } from "./wsMessaging";
import { wait } from "@depict-ai/utilishared/latest";
import { useBatteryValues } from "./battery/useBatteryValues";
import { mqttValueKeys } from "./sharedTypes";

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
  // TODO: automatically calculate battery capacity
  const owner = getOwner()!;
  const [configResource] = createResource(() => get_config_object(owner));

  createEffect(() => {
    const configResourceValue = configResource();
    if (!configResourceValue) return;
    const [config] = configResourceValue;
    const { mqttValues, mqttClient } = useMQTTValues(createMemo(() => config().mqtt_host));
    const feedWhenNoSolarDead = "feedWhenNoSolar is dead";
    const [lastChangingFeedWhenNoSolarReason, setLastChangingFeedWhenNoSolarReason] = createSignal<{
      what: string;
      when: number;
    }>({
      what: feedWhenNoSolarDead,
      when: +new Date(),
    });
    const {
      energyDischargedSinceEmpty,
      energyChargedSinceFull,
      energyChargedSinceEmpty,
      energyDischargedSinceFull,
      currentPower,
      totalLastEmpty,
      totalLastFull,
      energyRemovedSinceFull,
      energyAddedSinceEmpty,
      socSinceEmpty,
      socSinceFull,
      assumedParasiticConsumption,
      assumedCapacity,
    } = useBatteryValues(mqttValues, configResourceValue, mqttClient);

    createResource(() =>
      wsMessaging({
        config_signal: configResourceValue,
        owner,
        exposedAccessors: {
          energyAddedSinceEmpty,
          lastChangingFeedWhenNoSolarReason,
          energyDischargedSinceEmpty,
          energyChargedSinceEmpty,
          totalLastEmpty,
          currentBatteryPower: currentPower,
          energyRemovedSinceFull,
          energyDischargedSinceFull,
          energyChargedSinceFull,
          socSinceEmpty,
          socSinceFull,
          assumedCapacity,
          assumedParasiticConsumption,
          totalLastFull: () => totalLastFull() && new Date(totalLastFull()!).toISOString(),
          ...Object.fromEntries(mqttValueKeys.map(key => [key, () => mqttValues[key]])),
        },
      })
    );
  });
}
