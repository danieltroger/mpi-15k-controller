import { Accessor, createEffect } from "solid-js";
import { useFromMqttProvider } from "../mqttValues/MQTTValuesProvider";
import { reactiveBatteryVoltage } from "../mqttValues/mqttHelpers";
import { createStore, reconcile } from "solid-js/store";
import { log } from "../utilities/logging";

/**
 * Calculates what we expect the 230v input (grid) amperage to be when telling the inverter to charge the battery at a certain amperage (amperage at battery).
 */
export function useExpectedInputAmperage(batteryChargingAmperage: Accessor<number | undefined>) {
  const { mqttValues } = useFromMqttProvider();

  const [$calculatedHvAmpsPerPhase, setStore] = createStore<{
    ampsPhaseR?: number | undefined;
    ampsPhaseS?: number | undefined;
    ampsPhaseT?: number | undefined;
  }>({});

  createEffect(() => {
    const chargingAmpsBattery = batteryChargingAmperage();
    if (chargingAmpsBattery == undefined) return chargingAmpsBattery;
    const batteryVoltage = reactiveBatteryVoltage();
    if (batteryVoltage == undefined) return undefined;
    const wattsAtBattery = batteryVoltage * chargingAmpsBattery;
    const perPhaseAtInput = wattsAtBattery / 3;
    const loadPhaseR = mqttValues["ac_output_active_power_r"]?.value;
    const loadPhaseS = mqttValues["ac_output_active_power_s"]?.value;
    const loadPhaseT = mqttValues["ac_output_active_power_t"]?.value;
    if (!loadPhaseR || !loadPhaseS || !loadPhaseT) return undefined;
    const totalDrawPhaseR = loadPhaseR + perPhaseAtInput;
    const totalDrawPhaseS = loadPhaseS + perPhaseAtInput;
    const totalDrawPhaseT = loadPhaseT + perPhaseAtInput;
    const voltagePhaseR = mqttValues["ac_input_voltage_r"]?.value;
    const voltagePhaseS = mqttValues["ac_input_voltage_s"]?.value;
    const voltagePhaseT = mqttValues["ac_input_voltage_t"]?.value;
    if (!voltagePhaseR || !voltagePhaseS || !voltagePhaseT) return undefined;
    const ampsPhaseR = Math.round((totalDrawPhaseR / voltagePhaseR) * 10) / 10;
    const ampsPhaseS = Math.round((totalDrawPhaseS / voltagePhaseS) * 10) / 10;
    const ampsPhaseT = Math.round((totalDrawPhaseT / voltagePhaseT) * 10) / 10;

    log({
      batteryVoltage,
      voltagePhaseT,
      chargingAmpsBattery,
      wattsAtBattery,
      perPhaseAtInput,
      totalDrawPhaseT,
      ampsPhaseT,
      loadPhaseR,
      loadPhaseS,
      loadPhaseT,
      totalDrawPhaseR,
      totalDrawPhaseS,
      voltagePhaseR,
      voltagePhaseS,
      ampsPhaseR,
      ampsPhaseS,
    });

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

export function useLogExpectedVsActualChargingAmperage(batteryChargingAmperage: Accessor<number | undefined>) {
  const { mqttClient } = useFromMqttProvider();
  const { $calculatedHvAmpsPerPhase } = useExpectedInputAmperage(batteryChargingAmperage);
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
