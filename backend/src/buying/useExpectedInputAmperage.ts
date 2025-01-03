import { Accessor, createEffect } from "solid-js";
import { useFromMqttProvider } from "../mqttValues/MQTTValuesProvider";
import {
  reactiveAcInputVoltageR,
  reactiveAcInputVoltageS,
  reactiveAcInputVoltageT,
  reactiveBatteryVoltage,
} from "../mqttValues/mqttHelpers";
import { createStore, reconcile } from "solid-js/store";
import { log } from "../utilities/logging";

/**
 * Calculates what we expect the 230v input (grid) amperage to be when telling the inverter to charge the battery at a certain amperage (amperage at battery).
 */
export function useExpectedInputAmperage(
  batteryChargingAmperage: Accessor<number | undefined>,
  assumedParasiticConsumption: Accessor<number>
) {
  const { mqttValues } = useFromMqttProvider();

  const [$calculatedHvAmpsPerPhase, setStore] = createStore<{
    ampsPhaseR?: number | undefined;
    ampsPhaseS?: number | undefined;
    ampsPhaseT?: number | undefined;
  }>({});

  createEffect(() => {
    // TODO: take in consideration solar showing up too
    const chargingAmpsBattery = batteryChargingAmperage();
    if (!chargingAmpsBattery) {
      setStore({ ampsPhaseR: 0, ampsPhaseT: 0, ampsPhaseS: 0 });
      return;
    }
    const batteryVoltage = reactiveBatteryVoltage();
    if (batteryVoltage == undefined) return undefined;
    const wattsAtBattery = batteryVoltage * chargingAmpsBattery;
    const perPhaseAtInput = wattsAtBattery / 3;
    const loadPhaseR = mqttValues["ac_output_active_power_r"]?.value;
    const loadPhaseS = mqttValues["ac_output_active_power_s"]?.value;
    const loadPhaseT = mqttValues["ac_output_active_power_t"]?.value;
    if (!loadPhaseR || !loadPhaseS || !loadPhaseT) return undefined;
    const assumedSelfConsumptionPerPhase = assumedParasiticConsumption() / 3;
    const totalDrawPhaseR = loadPhaseR + perPhaseAtInput + assumedSelfConsumptionPerPhase;
    const totalDrawPhaseS = loadPhaseS + perPhaseAtInput + assumedSelfConsumptionPerPhase;
    const totalDrawPhaseT = loadPhaseT + perPhaseAtInput + assumedSelfConsumptionPerPhase;
    const voltagePhaseR = reactiveAcInputVoltageR();
    const voltagePhaseS = reactiveAcInputVoltageS();
    const voltagePhaseT = reactiveAcInputVoltageT();
    if (!voltagePhaseR || !voltagePhaseS || !voltagePhaseT) return undefined;
    const ampsPhaseR = Math.round((totalDrawPhaseR / voltagePhaseR) * 100) / 100;
    const ampsPhaseS = Math.round((totalDrawPhaseS / voltagePhaseS) * 100) / 100;
    const ampsPhaseT = Math.round((totalDrawPhaseT / voltagePhaseT) * 100) / 100;

    setStore(
      reconcile({
        ampsPhaseR,
        ampsPhaseS,
        ampsPhaseT,
      })
    );
  });

  return { $calculatedHvAmpsPerPhase };
}

export function useLogExpectedVsActualChargingAmperage(
  batteryChargingAmperage: Accessor<number | undefined>,
  assumedParasiticConsumption: Accessor<number>
) {
  const { mqttClient } = useFromMqttProvider();
  const { $calculatedHvAmpsPerPhase } = useExpectedInputAmperage(batteryChargingAmperage, assumedParasiticConsumption);
  const table = "input_amp_experiment";

  createEffect(() => {
    const client = mqttClient();
    if (!client) return;

    createEffect(() => {
      for (const key in $calculatedHvAmpsPerPhase) {
        createEffect(() => {
          const value = $calculatedHvAmpsPerPhase[key as keyof typeof $calculatedHvAmpsPerPhase];
          if (value == undefined) return;
          const influx_entry = `${table} calculated_${key}=${value}`;
          if (client.connected) {
            client.publish(table, influx_entry).catch(e => {
              log("Couldn't publish message", influx_entry, e);
            });
          }
        });
      }
    });
  });
}
