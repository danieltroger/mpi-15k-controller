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
import { errorLog } from "./utilities/logging.ts";
import { prematureFloatBugWorkaround } from "./battery/prematureFloatBugWorkaround.ts";
import { get_config_object } from "./config/config.ts";
import { wsMessaging } from "./websocketBackend/wsMessaging.ts";
import { wait } from "./vendor/depictUtilishared.ts";
import { useTemperatures } from "./temperatureMeasuring/useTemperatures.ts";
import { saveTemperatures } from "./temperatureMeasuring/saveTemperatures.ts";
import { feedWhenNoSolar } from "./feeding/feedWhenNoSolar.ts";
import { useBatteryValues } from "./battery/useBatteryValues.ts";
import { mqttValueKeys } from "./sharedTypes.ts";
import { elpatronSwitching } from "./elpatronSwitching.ts";
import { shouldSellPower } from "./feeding/shouldSellPower.ts";
import { NowProvider } from "./utilities/useNow.ts";
import { useShouldBuyPower } from "./buying/useShouldBuyPower.ts";
import { MQTTValuesProvider, useFromMqttProvider } from "./mqttValues/MQTTValuesProvider.ts";
import { useCurrentMeasuring } from "./currentMeasuring/useCurrentMeasuring.ts";
import { UsbInverterConfigurationProvider } from "./usbInverterConfiguration/UsbInverterConfigurationProvider.ts";
import { useAutoTrader } from "./autoTrading/autoTrader.ts";

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
          errorLog("Main crashed, restarting in 10s", e);
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
  // TODO: Alerts when battery overheats / program restarts
  // TODO: add typecheck CI pipeline
  // TODO: when battery completely empty and essentially disconnected for everything except charging, don't count inverter idle consumption as coming from the battery
  const owner = getOwner()!;
  const [configResource] = createResource(() => get_config_object(owner));

  createEffect(() => {
    const configResourceValue = configResource();
    if (!configResourceValue) return;
    const [config] = configResourceValue;

    MQTTValuesProvider({
      mqttHost: createMemo(() => config().mqtt_host),
      get children() {
        return UsbInverterConfigurationProvider({
          config,
          get children() {
            const hasCredentials = createMemo(() => !!(config().shinemonitor_password && config().shinemonitor_user));
            const hasInverterDetails = createMemo(() => !!(config().inverter_sn && config().inverter_sn));
            const [prematureWorkaroundErrored, setPrematureWorkaroundErrored] = createSignal(false);
            const [feedWhenNoSolarErrored, setFeedWhenNoSolarErrored] = createSignal(false);
            const [currentMeasuringErrored, setCurrentMeasuringErrored] = createSignal(false);
            const [elpatronSwitchingErrored, setElpatronSwitchingErrored] = createSignal(false);
            const feedWhenNoSolarDead = "feedWhenNoSolar is dead";
            const [lastFeedWhenNoSolarReason, setLastFeedWhenNoSolarReason] = createSignal<{
              what: string;
              when: number;
            }>({
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
            const currentMeasuringEnabled = createMemo(() => config().current_measuring.enabled);
            const currentReturn = createMemo(() => {
              if (currentMeasuringErrored() || !currentMeasuringEnabled()) return;
              return catchError(
                () => {
                  const sensor1 = useCurrentMeasuring(config, false);
                  const sensor2 = useCurrentMeasuring(config, true);
                  return { sensor1, sensor2 };
                },
                e => {
                  setCurrentMeasuringErrored(true);
                  errorLog("Current measuring errored", e, "restarting in 60s");
                  setTimeout(() => setCurrentMeasuringErrored(false), 60_000);
                }
              );
            });
            const currentPower = createMemo(() => currentReturn()?.sensor2.calculatedPowerFromAmpMeter?.());
            const {
              totalLastEmpty,
              totalLastFull,
              energyRemovedSinceFull,
              energyAddedSinceEmpty,
              socSinceEmpty,
              socSinceFull,
              assumedParasiticConsumption,
              assumedCapacity,
              averageSOC,
            } = useBatteryValues(configResourceValue, currentPower);

            const temperatures = useTemperatures(config);
            saveTemperatures({ config, temperatures });

            const [autoTraderErrored, setAutoTraderErrored] = createSignal(false);
            const autoTrader = createMemo(() => {
              if (autoTraderErrored()) return;
              return catchError(
                () =>
                  useAutoTrader({
                    configSignal: configResourceValue,
                    averageSOC,
                    assumedParasiticConsumption,
                  }),
                e => {
                  setAutoTraderErrored(true);
                  errorLog("Auto trader errored", e, "restarting in 60s");
                  setTimeout(() => setAutoTraderErrored(false), 60_000);
                }
              );
            });

            const isChargingOuterScope = createMemo(() => {
              if (!hasCredentials()) {
                return errorLog(
                  "No credentials configured, please set shinemonitor_password and shinemonitor_user in config.json. PREMATURE FLOAT BUG WORKAROUND (and feed when no solar) DISABLED!"
                );
              } else if (!hasInverterDetails()) {
                return errorLog(
                  "No inverter details configured, please set inverter_sn and inverter_pn in config.json. PREMATURE FLOAT BUG WORKAROUND (and feed when no solar) DISABLED!"
                );
              }
              const { exportAmountForSelling } = shouldSellPower(config, averageSOC);
              const { chargingAmperageForBuying } = useShouldBuyPower({
                config,
                averageSOC,
                assumedParasiticConsumption,
              });
              const isCharging = createMemo(() => {
                if (prematureWorkaroundErrored()) return;
                return catchError(
                  () =>
                    prematureFloatBugWorkaround({
                      configSignal: configResourceValue,
                      energyRemovedSinceFull,
                    }),
                  e => {
                    setPrematureWorkaroundErrored(true);
                    errorLog("Premature float bug workaround errored", e, "restarting in 60s");
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
                      configSignal: configResourceValue,
                      isCharging: () => isCharging()?.(),
                      setLastChangingReason: setLastChangingFeedWhenNoSolarReason,
                      setLastReason: setLastFeedWhenNoSolarReason,
                      exportAmountForSelling,
                      chargingAmperageForBuying,
                      assumedParasiticConsumption,
                    });
                  },
                  e => {
                    setFeedWhenNoSolarErrored(true);
                    errorLog("Feed when no solar errored", e, "restarting in 60s");
                    setTimeout(() => setFeedWhenNoSolarErrored(false), 60_000);
                  }
                );
              });

              return isCharging;
            });
            const { mqttValues } = useFromMqttProvider();
            createResource(() =>
              wsMessaging({
                config_signal: configResourceValue,
                owner,
                temperatures,
                actions: {
                  generate_trading_plan: async () => {
                    const trader = autoTrader();
                    if (!trader) return "auto trader not running";
                    return await trader.triggerPlanNow();
                  },
                },
                exposedAccessors: {
                  autoTraderStatus: () => autoTrader()?.autoTraderStatus(),
                  energyAddedSinceEmpty,
                  lastFeedWhenNoSolarReason,
                  lastChangingFeedWhenNoSolarReason,
                  totalLastEmpty,
                  currentBatteryPower: currentPower,
                  energyRemovedSinceFull,
                  voltageSagMillivoltsRaw: () => currentReturn()?.sensor1.voltageSagMillivoltsRaw(),
                  voltageSagMillivoltsAveraged: () => currentReturn()?.sensor1.voltageSagMillivoltsAveraged(),
                  voltageSagMillivoltsRaw2: () => currentReturn()?.sensor2.voltageSagMillivoltsRaw(),
                  voltageSagMillivoltsAveraged2: () => currentReturn()?.sensor2.voltageSagMillivoltsAveraged(),
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
                () => elpatronSwitching(config),
                e => {
                  setElpatronSwitchingErrored(true);
                  errorLog("Elpatron switching errored", e, "restarting in 60s");
                  setTimeout(() => setFeedWhenNoSolarErrored(false), 60_000);
                }
              );
            });

            return undefined;
          },
        });
      },
    });
  });
}
