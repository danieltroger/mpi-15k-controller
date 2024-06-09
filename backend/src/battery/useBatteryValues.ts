import { useCurrentPower } from "./useCurrentPower";
import { useNow } from "../utilities/useNow";
import { useDatabasePower } from "./useDatabasePower";
import { createEffect, createMemo, Resource } from "solid-js";
import { useMQTTValues } from "../useMQTTValues";
import { get_config_object } from "../config";
import { AsyncMqttClient } from "async-mqtt";
import { appendFile } from "fs/promises";
import { error } from "../utilities/logging";

export function useBatteryValues(
  mqttValues: ReturnType<typeof useMQTTValues>["mqttValues"],
  configSignal: Awaited<ReturnType<typeof get_config_object>>,
  mqttClient: Resource<AsyncMqttClient>
) {
  const [config] = configSignal;
  const {
    localPowerHistory,
    currentPower,
    lastBatterySeenFullSinceProgramStart,
    lastBatterySeenEmptySinceProgramStart,
  } = useCurrentPower(mqttValues, configSignal);
  const now = useNow();
  const {
    databasePowerValues,
    batteryWasLastFullAtAccordingToDatabase,
    batteryWasLastEmptyAtAccordingToDatabase,
    whenWereWeEmpty,
    whenWereWeFullCirca,
  } = useDatabasePower(configSignal);

  const assumedParasiticConsumption = createMemo(() => config().soc_calculations.current_state.parasitic_consumption);
  const assumedCapacity = createMemo(() => config().soc_calculations.current_state.capacity);

  // Capacity values assuming no parasitic consumption
  const uncorrectedCapacity = createMemo(() => {
    const powerValues = databasePowerValues();
    const whenEmpty = whenWereWeEmpty();
    const whenFull = whenWereWeFullCirca();
    if (!powerValues.length || !whenEmpty?.length || !whenFull?.length) return;

    const sortedWhenEmpty = whenEmpty.sort((a, b) => a.time - b.time).reverse();
    const sortedWhenFull = whenFull.sort((a, b) => a.time - b.time).reverse();

    const output: string[] = [];
    let energyChargedSinceFull = 0;
    let energyDischargedSinceFull = 0;
    let energyChargedSinceEmpty = 0;
    let energyDischargedSinceEmpty = 0;
    let nextResetEmpty = sortedWhenEmpty.pop();
    let nextResetFull = sortedWhenFull.pop();

    for (let i = 0; i < powerValues.length; i++) {
      const power = powerValues[i];
      const nextPower = powerValues[i + 1];
      if (!nextPower) break;
      if (nextResetEmpty && power.time > nextResetEmpty.time) {
        energyChargedSinceEmpty = 0;
        energyDischargedSinceEmpty = 0;
        nextResetEmpty = sortedWhenEmpty.pop();
      }
      if (nextResetFull && power.time > nextResetFull.time) {
        energyChargedSinceFull = 0;
        energyDischargedSinceFull = 0;
        nextResetFull = sortedWhenFull.pop();
      }
      const correctedPowerValue = power.value;
      const timeDiff = nextPower.time - power.time;
      const energy = (correctedPowerValue * timeDiff) / 1000 / 60 / 60;
      if (correctedPowerValue > 0) {
        energyChargedSinceFull += energy;
        energyChargedSinceEmpty += energy;
      } else if (correctedPowerValue < 0) {
        energyDischargedSinceFull += energy;
        energyDischargedSinceEmpty += energy;
      }
      const energyRemovedSinceFull = Math.abs(energyDischargedSinceFull) - Math.abs(energyChargedSinceFull);
      const energyAddedSinceEmpty = Math.abs(energyChargedSinceEmpty) - Math.abs(energyDischargedSinceEmpty);
      output.push(
        `soc_playground_1 capacity=${energyRemovedSinceFull + energyAddedSinceEmpty} ${Math.round(power.time / 1000)}`,
        `soc_playground_1 energyDischargedSinceFull=${energyDischargedSinceFull} ${Math.round(power.time / 1000)}`,
        `soc_playground_1 energyChargedSinceFull=${energyChargedSinceFull} ${Math.round(power.time / 1000)}`,
        `soc_playground_1 energyChargedSinceEmpty=${energyChargedSinceEmpty} ${Math.round(power.time / 1000)}`,
        `soc_playground_1 energyDischargedSinceEmpty=${energyDischargedSinceEmpty} ${Math.round(power.time / 1000)}`,
        `soc_playground_1 energyRemovedSinceFull=${energyRemovedSinceFull} ${Math.round(power.time / 1000)}`,
        `soc_playground_1 energyAddedSinceEmpty=${energyAddedSinceEmpty} ${Math.round(power.time / 1000)}`
      );
    }

    return output;
  });

  createEffect(() => {
    const result = uncorrectedCapacity();
    if (!result?.length) return;

    appendFile(
      "simulation-output-" + new Date().toISOString() + ".txt",
      `# DML
# CONTEXT-DATABASE: mppsolar
# CONTEXT-RETENTION-POLICY: autogen
` + result.join("\n"),
      "utf8"
    ).catch(e => error("Failed to save output", e));
  });

  return {
    currentPower,
    assumedCapacity,
    assumedParasiticConsumption,
  };
}
