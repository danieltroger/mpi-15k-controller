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
import { useTotalSolarPower } from "../utilities/useTotalSolarPower";

/**
 * Calculates what we expect the 230v input (grid) amperage to be when telling the inverter to charge the battery at a certain amperage (amperage at battery).
 */
export function useExpectedInputAmperage(
  batteryChargingAmperage: Accessor<number | undefined>,
  assumedParasiticConsumption: Accessor<number>
) {
  const { mqttValues } = useFromMqttProvider();

  const [$calculatedGridAmpsPerPhase, setStore] = createStore<{
    ampsFromGridR?: number | undefined;
    ampsFromGridS?: number | undefined;
    ampsFromGridT?: number | undefined;
  }>({});

  createEffect(() => {
    const chargingAmpsBattery = batteryChargingAmperage();
    if (!chargingAmpsBattery) {
      setStore({ ampsFromGridR: 0, ampsFromGridS: 0, ampsFromGridT: 0 });
      return;
    }
    const batteryVoltage = reactiveBatteryVoltage();
    if (batteryVoltage == undefined) return undefined;
    const wattsAtBattery = batteryVoltage * chargingAmpsBattery;
    const perPhaseGridChargingPowerAtInput = wattsAtBattery / 3;
    const acOutPowerR = mqttValues["ac_output_active_power_r"]?.value;
    const acOutPowerS = mqttValues["ac_output_active_power_s"]?.value;
    const acOutPowerT = mqttValues["ac_output_active_power_t"]?.value;
    if (!acOutPowerR || !acOutPowerS || !acOutPowerT) return undefined;
    let solarPowerToDistribute = useTotalSolarPower() ?? 0;
    const assumedSelfConsumptionPerPhase = assumedParasiticConsumption() / 3;
    // Not yet including charger watts as they can't be canceled out by solar
    const totalPowerFromGrid = {
      r: acOutPowerR + assumedSelfConsumptionPerPhase,
      s: acOutPowerS + assumedSelfConsumptionPerPhase,
      t: acOutPowerT + assumedSelfConsumptionPerPhase,
    };
    // Now, we have to think about if the sun is shining at the same time - we won't pull AC output from the grid yet
    const satisfiedPhases = new Set<"r" | "s" | "t">();
    // First, every phase gets an equal amount of solar power
    // Then, if there's still solar power left, it gets shared equally among the phases until there's nothing left
    while (solarPowerToDistribute >= 1 && satisfiedPhases.size < 3) {
      const solarForEachPhase = solarPowerToDistribute / (3 - satisfiedPhases.size);
      for (const phase in totalPowerFromGrid) {
        if (satisfiedPhases.has(phase as keyof typeof totalPowerFromGrid)) continue;
        const draw = totalPowerFromGrid[phase as keyof typeof totalPowerFromGrid];
        const usesFromSolar = Math.min(draw, solarForEachPhase);
        const newDraw = draw - usesFromSolar;
        if (newDraw <= 0) {
          satisfiedPhases.add(phase as keyof typeof totalPowerFromGrid);
        }
        totalPowerFromGrid[phase as keyof typeof totalPowerFromGrid] = newDraw;
        solarPowerToDistribute -= usesFromSolar;
      }
    }
    // What if still solar left?? Doesn't matter for us, it goes to the battery.

    // Now we add the grid charging power
    totalPowerFromGrid.r += perPhaseGridChargingPowerAtInput;
    totalPowerFromGrid.s += perPhaseGridChargingPowerAtInput;
    totalPowerFromGrid.t += perPhaseGridChargingPowerAtInput;

    // Convert from power to amperage
    const voltagePhaseR = reactiveAcInputVoltageR();
    const voltagePhaseS = reactiveAcInputVoltageS();
    const voltagePhaseT = reactiveAcInputVoltageT();
    if (!voltagePhaseR || !voltagePhaseS || !voltagePhaseT) return undefined;
    const ampsFromGridR = Math.round((totalPowerFromGrid.r / voltagePhaseR) * 100) / 100;
    const ampsFromGridS = Math.round((totalPowerFromGrid.s / voltagePhaseS) * 100) / 100;
    const ampsFromGridT = Math.round((totalPowerFromGrid.t / voltagePhaseT) * 100) / 100;

    setStore(
      reconcile({
        ampsFromGridR,
        ampsFromGridS,
        ampsFromGridT,
      })
    );
  });

  return { $calculatedGridAmpsPerPhase };
}

export function useLogExpectedVsActualChargingAmperage(
  batteryChargingAmperage: Accessor<number | undefined>,
  assumedParasiticConsumption: Accessor<number>
) {
  const { mqttClient } = useFromMqttProvider();
  const { $calculatedGridAmpsPerPhase } = useExpectedInputAmperage(
    batteryChargingAmperage,
    assumedParasiticConsumption
  );
  const table = "input_amp_experiment";

  createEffect(() => {
    const client = mqttClient();
    if (!client) return;

    createEffect(() => {
      for (const key in $calculatedGridAmpsPerPhase) {
        createEffect(() => {
          const value = $calculatedGridAmpsPerPhase[key as keyof typeof $calculatedGridAmpsPerPhase];
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
