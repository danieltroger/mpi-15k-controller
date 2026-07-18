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
import { BatteryValuesProvider } from "./battery/BatteryValuesProvider.ts";
import { mqttValueKeys, type MqttValue, type MqttValueKey } from "./sharedTypes.ts";
import { elpatronSwitching } from "./elpatronSwitching.ts";
import { shouldSellPower } from "./feeding/shouldSellPower.ts";
import { NowProvider } from "./utilities/useNow.ts";
import { useShouldBuyPower } from "./buying/useShouldBuyPower.ts";
import { MQTTValuesProvider, useFromMqttProvider } from "./mqttValues/MQTTValuesProvider.ts";
import { useCurrentMeasuring } from "./currentMeasuring/useCurrentMeasuring.ts";
import { UsbInverterConfigurationProvider } from "./usbInverterConfiguration/UsbInverterConfigurationProvider.ts";
import { InfluxClientProvider } from "./utilities/InfluxClientProvider.ts";
import { useAutoTrader } from "./autoTrading/autoTrader.ts";
import { latestSpotPrices } from "./autoTrading/priceService.ts";
import { pollSpotPricesForFrontend } from "./autoTrading/spotPricePolling.ts";
import { alertOnMainCrash, createAlertManager } from "./alerting/alertManager.ts";
import { startAlertRules } from "./alerting/alertRules.ts";

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
          // Also escalates: a second crash within 30 min pages as P1 (crash loop = controller down)
          alertOnMainCrash(e);
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
            return InfluxClientProvider({
              config,
              get children() {
                const hasCredentials = createMemo(
                  () => !!(config().shinemonitor_password && config().shinemonitor_user)
                );
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
                const batteryCurrentAmps = createMemo(() => currentReturn()?.sensor2.calculatedCurrentFromAmpMeter?.());
                const smoothedBatteryCurrentAmps = createMemo(() => currentReturn()?.sensor2.smoothedCurrent?.());
                const batteryValues = useBatteryValues(configResourceValue, {
                  batteryCurrentAmps,
                  smoothedBatteryCurrentAmps,
                });
                const { socAh, clampedSocAh, latestAnchor } = batteryValues;

                return BatteryValuesProvider({
                  value: batteryValues,
                  get children() {
                    const temperatures = useTemperatures(config);
                    saveTemperatures({ config, temperatures });

                    pollSpotPricesForFrontend(config);

                    const [autoTraderErrored, setAutoTraderErrored] = createSignal(false);
                    const autoTrader = createMemo(() => {
                      if (autoTraderErrored()) return;
                      return catchError(
                        () => useAutoTrader({ configSignal: configResourceValue }),
                        e => {
                          setAutoTraderErrored(true);
                          errorLog("Auto trader errored", e, "restarting in 60s");
                          setTimeout(() => setAutoTraderErrored(false), 60_000);
                        }
                      );
                    });

                    const { mqttValues } = useFromMqttProvider();
                    const alertManager = createAlertManager(config);
                    catchError(
                      () =>
                        startAlertRules({
                          config,
                          manager: alertManager,
                          temperatures,
                          mqttValues,
                          averageSOC: clampedSocAh,
                          currentBatteryPower: currentPower,
                          autoTraderStatus: () => autoTrader()?.autoTraderStatus(),
                        }),
                      // Alerting going down must never take the controller with it — and this failure
                      // is itself worth a push, which the errorLog hook provides.
                      e => errorLog("Alert rules crashed — alerting rules disabled until restart", e)
                    );

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
                      const { exportAmountForSelling } = shouldSellPower(config);
                      const { chargingAmperageForBuying } = useShouldBuyPower({ config });
                      const isCharging = createMemo(() => {
                        if (prematureWorkaroundErrored()) return;
                        return catchError(
                          () =>
                            prematureFloatBugWorkaround({
                              configSignal: configResourceValue,
                              clampedSocAh,
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
                    // Memo (not effect) so the returned live heater state can be exposed over the ws
                    const elpatronReturn = createMemo(() => {
                      if (elpatronSwitchingErrored()) return;
                      return catchError(
                        () => elpatronSwitching(config),
                        e => {
                          setElpatronSwitchingErrored(true);
                          errorLog("Elpatron switching errored", e, "restarting in 60s");
                          setTimeout(() => setElpatronSwitchingErrored(false), 60_000);
                        }
                      );
                    });
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
                          clear_trading_vetoes: async () => {
                            const trader = autoTrader();
                            if (!trader) return "auto trader not running";
                            return await trader.clearTradingVetoes();
                          },
                          send_test_alert: async () => {
                            const record = await alertManager.raise({
                              // Unique per press: re-testing a silent phone is the whole point, so the
                              // cooldown must never swallow a manual test (review: PR #37).
                              key: `test-alert-${Date.now()}`,
                              severity: "P2",
                              title: "Test alert",
                              message:
                                "Manual test from the dashboard — if you can read this on your phone, alerting works",
                            });
                            return `delivery: ${record.delivery}${record.detail ? ` (${record.detail})` : ""}`;
                          },
                        },
                        exposedAccessors: {
                          autoTraderStatus: () => autoTrader()?.autoTraderStatus(),
                          spotPrices: latestSpotPrices,
                          recentAlerts: alertManager.recentAlerts,
                          lastFeedWhenNoSolarReason,
                          lastChangingFeedWhenNoSolarReason,
                          currentBatteryPower: currentPower,
                          voltageSagMillivoltsRaw: () => currentReturn()?.sensor1.voltageSagMillivoltsRaw(),
                          voltageSagMillivoltsAveraged: () => currentReturn()?.sensor1.voltageSagMillivoltsAveraged(),
                          voltageSagMillivoltsRaw2: () => currentReturn()?.sensor2.voltageSagMillivoltsRaw(),
                          voltageSagMillivoltsAveraged2: () => currentReturn()?.sensor2.voltageSagMillivoltsAveraged(),
                          // THE SOC the whole app runs on: the Ah ledger clamped to [0,100]. Kept under the
                          // stable "averageSOC" key the frontend already reads; socAh is the raw unclamped drift.
                          averageSOC: clampedSocAh,
                          socAh,
                          // Latest full/empty/soft-empty anchor — the frontend's "last full / last empty" source.
                          latestAnchor,
                          isCharging: () => isChargingOuterScope()?.()?.(),
                          elpatronState: () => elpatronReturn()?.elpatronHeating(),
                          // Object.fromEntries can't carry the per-key mapping — the cast restores
                          // what is provably true from mqttValueKeys.map
                          ...(Object.fromEntries(mqttValueKeys.map(key => [key, () => mqttValues[key]])) as {
                            [K in MqttValueKey]: () => MqttValue | undefined;
                          }),
                        },
                      })
                    );
                    return undefined;
                  },
                });
              },
            });
          },
        });
      },
    });
  });
}
