import {
  catchError,
  createEffect,
  createMemo,
  createResource,
  createRoot,
  createSignal,
  getOwner,
  onCleanup,
} from "solid-js";
import { error } from "./utilities/logging";
import { useMQTTValues } from "./useMQTTValues";
import { prematureFloatBugWorkaround } from "./battery/prematureFloatBugWorkaround";
import { get_config_object } from "./config";
import { wsMessaging } from "./wsMessaging";
import { wait } from "@depict-ai/utilishared/latest";
import { useTemperatures } from "./useTemperatures";
import { saveTemperatures } from "./saveTemperatures";
import { feedWhenNoSolar } from "./feeding/feedWhenNoSolar";
import { useBatteryValues } from "./battery/useBatteryValues";
import { mqttValueKeys } from "./sharedTypes";
import { elpatronSwitching } from "./elpatronSwitching";
import { shouldSellPower } from "./feeding/shouldSellPower";
import { NowProvider } from "./utilities/useNow";
import { useShouldBuyPower } from "./buying/useShouldBuyPower";

while (true) {
  await new Promise<void>(r => {
    createRoot(dispose => {
      catchError(
        () => {
          NowProvider({
            get children() {
              return void main();
            },
          });
        },
        e => {
          error("Main crashed, restarting in 10s", e);
          dispose();
          r();
        }
      );
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
  // TODO: when AC output power high/peaks, increase feedWhenNoSolar by like 200w, see http://192.168.1.102:3000/d/cdhmg2rukhkw0d/first-dashboard?orgId=1&from=1724141592000&to=1724143359154 (second glitch that makes us pull from grid example http://192.168.0.3:3002/d/cdhmg2rukhkw0d/first-dashboard?orgId=1&from=1723970675920&to=1723982588592)
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
    const [elpatronSwitchingErrored, setElpatronSwitchingErrored] = createSignal(false);
    const feedWhenNoSolarDead = "feedWhenNoSolar is dead";
    const [lastFeedWhenNoSolarReason, setLastFeedWhenNoSolarReason] = createSignal<{ what: string; when: number }>({
      what: feedWhenNoSolarDead,
      when: +new Date(),
    });
    const [lastChangingFeedWhenNoSolarReason, setLastChangingFeedWhenNoSolarReason] = createSignal<{
      what: string;
      when: number;
    }>({
      what: feedWhenNoSolarDead,
      when: +new Date(),
    });
    const {
      currentPower,
      totalLastEmpty,
      totalLastFull,
      energyRemovedSinceFull,
      energyAddedSinceEmpty,
      socSinceEmpty,
      socSinceFull,
      assumedParasiticConsumption,
      assumedCapacity,
      averageSOC,
    } = useBatteryValues(mqttValues, configResourceValue, mqttClient);
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
      const { exportAmountForSelling } = shouldSellPower(config, averageSOC);
      const { chargingAmperageForBuying } = useShouldBuyPower(config, averageSOC);
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
            error("Premature float bug workaround errored", e, "restarting in 60s");
            setTimeout(() => setPrematureWorkaroundErrored(false), 60_000);
          }
        );
      });

      createEffect(() => {
        if (feedWhenNoSolarErrored()) return;
        catchError(
          () => {
            const obj = { what: "Initialising", when: +new Date() };
            setLastChangingFeedWhenNoSolarReason(obj);
            setLastFeedWhenNoSolarReason(obj);
            onCleanup(() => {
              const obj = { what: feedWhenNoSolarDead, when: +new Date() };
              setLastChangingFeedWhenNoSolarReason(obj);
              setLastFeedWhenNoSolarReason(obj);
            });
            return feedWhenNoSolar({
              mqttValues: mqttValues,
              configSignal: configResourceValue,
              isCharging: () => isCharging()?.(),
              setLastChangingReason: setLastChangingFeedWhenNoSolarReason,
              setLastReason: setLastFeedWhenNoSolarReason,
              exportAmountForSelling,
              chargingAmperageForBuying,
            });
          },
          e => {
            setFeedWhenNoSolarErrored(true);
            error("Feed when no solar errored", e, "restarting in 60s");
            setTimeout(() => setFeedWhenNoSolarErrored(false), 60_000);
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
          energyAddedSinceEmpty,
          lastFeedWhenNoSolarReason,
          lastChangingFeedWhenNoSolarReason,
          totalLastEmpty,
          currentBatteryPower: currentPower,
          energyRemovedSinceFull,
          socSinceEmpty,
          socSinceFull,
          assumedCapacity,
          assumedParasiticConsumption,
          isCharging: () => isChargingOuterScope()?.()?.(),
          totalLastFull: () => totalLastFull() && new Date(totalLastFull()!).toISOString(),
          ...Object.fromEntries(mqttValueKeys.map(key => [key, () => mqttValues[key]])),
        },
      })
    );
    createEffect(() => {
      if (elpatronSwitchingErrored()) return;
      catchError(
        () => elpatronSwitching(config, mqttValues),
        e => {
          setElpatronSwitchingErrored(true);
          error("Elpatron switching errored", e, "restarting in 60s");
          setTimeout(() => setFeedWhenNoSolarErrored(false), 60_000);
        }
      );
    });
  });
}
