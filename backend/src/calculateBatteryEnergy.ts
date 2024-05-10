import { Accessor, createMemo } from "solid-js";
import { get_config_object } from "./config";

export function calculateBatteryEnergy({
  from,
  to,
  databasePowerValues,
  localPowerHistory,
  config,
}: {
  /**
   * Unix timestamp in milliseconds
   */
  from: Accessor<number | undefined>;
  to: Accessor<number>;
  /**
   * Reactive store with the local power history
   */
  localPowerHistory: Accessor<{ value: number; time: number }[]>;
  databasePowerValues: Accessor<{ time: number; value: number }[]>;
  config: Awaited<ReturnType<typeof get_config_object>>[0];
}) {
  const totalPowerHistory = createMemo(() => {
    const fromValue = from();
    if (!fromValue) return [];
    const localPower = localPowerHistory().filter(({ time }) => time >= fromValue && time <= to());
    const databasePower = databasePowerValues().filter(({ time }) => time >= fromValue && time <= to());
    const firstLocalPower = localPower[0]?.time;
    const filteredDatabasePower = databasePower.filter(({ time }) => time <= firstLocalPower);
    return [...filteredDatabasePower, ...localPower];
  });
  const subtractFromPower = createMemo(() => config().parasitic_consumption_for_energy_calculations);

  const energy = createMemo(() => {
    const powerValues = totalPowerHistory();
    if (!powerValues?.length) return;
    let energyCharged = 0;
    let energyDischarged = 0;
    for (let i = 0; i < powerValues.length; i++) {
      const power = powerValues[i];
      const nextPower = powerValues[i + 1];
      if (!nextPower) break;
      const correctedPowerValue = power.value - subtractFromPower();
      const timeDiff = nextPower.time - power.time;
      const energy = (correctedPowerValue * timeDiff) / 1000 / 60 / 60;
      if (correctedPowerValue > 0) {
        energyCharged += energy;
      } else if (correctedPowerValue < 0) {
        energyDischarged += energy;
      }
    }
    return { energyCharged, energyDischarged };
  });

  return {
    energyCharged: createMemo(() => energy()?.energyCharged),
    energyDischarged: createMemo(() => energy()?.energyDischarged),
  };
}
