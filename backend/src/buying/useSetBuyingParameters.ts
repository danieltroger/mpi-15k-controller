import type { Accessor } from "solid-js";
import { useLogExpectedVsActualChargingAmperage } from "./useExpectedInputAmperage.ts";
import { useInverterComms } from "../inverterComms/InverterCommsProvider.ts";
import { useBatteryValuesProvider } from "../battery/BatteryValuesProvider.ts";
import { reactiveBatteryVoltage } from "../mqttValues/mqttHelpers.ts";
import { useTotalSolarPower } from "../utilities/useTotalSolarPower.ts";
import { useNow } from "../utilities/useNow.ts";
import { wireBuyingSetters } from "./buyingSetterWiring.ts";

export function useSetBuyingParameters({
  stillFeedingIn,
  chargingAmperageForBuying,
  idleConsumptionWatts,
}: {
  stillFeedingIn: Accessor<boolean>;
  chargingAmperageForBuying: Accessor<number | undefined>;
  idleConsumptionWatts: Accessor<number>;
}) {
  const { $usbValues, queueSetter, lastDecodedRound, unprovenWrites, requestSettingsReadback, settingsReadbackAtMs } =
    useInverterComms();
  const { batteryCurrentAmps } = useBatteryValuesProvider();
  const { currentlyBuying } = wireBuyingSetters({
    stillFeedingIn,
    chargingAmperageForBuying,
    acChargeBatteryState: () => $usbValues.ac_charge_battery,
    lastDecodedRound,
    batteryCurrentAmps,
    // These read their providers when called, from inside the wiring's computations
    solarWatts: useTotalSolarPower,
    batteryVoltage: reactiveBatteryVoltage,
    clockTick: useNow,
    queueSetter,
    unprovenWrites,
    requestSettingsReadback,
    settingsReadbackAtMs,
    monotonicNowMs: () => performance.now(),
    wallClockNowMs: () => Date.now(),
  });

  useLogExpectedVsActualChargingAmperage(chargingAmperageForBuying, idleConsumptionWatts);

  return { currentlyBuying };
}
