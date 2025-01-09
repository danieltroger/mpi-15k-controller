import { Accessor, createMemo } from "solid-js";
import { useFromMqttProvider } from "../mqttValues/MQTTValuesProvider";
import {
  reactiveAcInputVoltageR,
  reactiveAcInputVoltageS,
  reactiveAcInputVoltageT,
  reactiveBatteryVoltage,
} from "../mqttValues/mqttHelpers";
import { useTotalSolarPower } from "../utilities/useTotalSolarPower";

/**
 * Takes in a desired amperage at the grid connection and returns the current maximum amperage we can tell the inverter to charge the battery from the grid with.
 */
export function calculateChargingAmperage(
  targetAmpsAtGridConnection: number,
  assumedParasiticConsumption: Accessor<number>
) {
  const { mqttValues } = useFromMqttProvider();
  const batteryVoltage = reactiveBatteryVoltage();
  if (batteryVoltage == undefined) return undefined;
  const acOutPowerR = mqttValues["ac_output_active_power_r"]?.value;
  const acOutPowerS = mqttValues["ac_output_active_power_s"]?.value;
  const acOutPowerT = mqttValues["ac_output_active_power_t"]?.value;
  if (acOutPowerR == undefined || acOutPowerS == undefined || acOutPowerT == undefined) return undefined;
  let solarPowerToDistribute = useTotalSolarPower() ?? 0;
  const assumedSelfConsumptionPerPhase = assumedParasiticConsumption() / 3;
  // Not yet including charger watts as they can't be canceled out by solar
  const powerConsumedByHouse = {
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
    for (const phase in powerConsumedByHouse) {
      if (satisfiedPhases.has(phase as keyof typeof powerConsumedByHouse)) continue;
      const draw = powerConsumedByHouse[phase as keyof typeof powerConsumedByHouse];
      const usesFromSolar = Math.min(draw, solarForEachPhase);
      const newDraw = draw - usesFromSolar;
      if (newDraw <= 0) {
        satisfiedPhases.add(phase as keyof typeof powerConsumedByHouse);
      }
      powerConsumedByHouse[phase as keyof typeof powerConsumedByHouse] = newDraw;
      solarPowerToDistribute -= usesFromSolar;
    }
  }
  // What if still solar left?? Doesn't matter for us, it goes to the battery.

  // Convert from power to amperage
  const voltagePhaseR = reactiveAcInputVoltageR();
  const voltagePhaseS = reactiveAcInputVoltageS();
  const voltagePhaseT = reactiveAcInputVoltageT();
  if (!voltagePhaseR || !voltagePhaseS || !voltagePhaseT) return undefined;
  const targetGridPowerR = targetAmpsAtGridConnection * voltagePhaseR;
  const targetGridPowerS = targetAmpsAtGridConnection * voltagePhaseS;
  const targetGridPowerT = targetAmpsAtGridConnection * voltagePhaseT;

  // Now only power left when subtracting idle and house consumption is the desired charging power
  const targetPowerWithoutHouseR = targetGridPowerR - powerConsumedByHouse.r;
  const targetPowerWithoutHouseS = targetGridPowerS - powerConsumedByHouse.s;
  const targetPowerWithoutHouseT = targetGridPowerT - powerConsumedByHouse.t;

  // Convert charging power to amperage at battery
  // Use phase with the smallest target charging power because if we draw more on that one it will blow the fuse
  // (It has the highest other loads)
  const smallestTargetChargingPower = Math.min(
    targetPowerWithoutHouseR,
    targetPowerWithoutHouseS,
    targetPowerWithoutHouseT
  );
  const chargingAmpsBattery = (smallestTargetChargingPower / batteryVoltage) * 3;
  return chargingAmpsBattery;
}
