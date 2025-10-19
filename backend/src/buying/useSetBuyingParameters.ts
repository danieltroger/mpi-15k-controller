import { Accessor, createEffect, createMemo } from "solid-js";
import { useLogExpectedVsActualChargingAmperage } from "./useExpectedInputAmperage";
import { useUsbInverterConfiguration } from "../usbInverterConfiguration/UsbInverterConfigurationProvider";

export function useSetBuyingParameters({
  stillFeedingIn,
  chargingAmperageForBuying,
  assumedParasiticConsumption,
}: {
  stillFeedingIn: Accessor<boolean>;
  chargingAmperageForBuying: Accessor<number | undefined>;
  assumedParasiticConsumption: Accessor<number>;
}) {
  const { $usbValues, setCommandQueue, triggerGettingUsbValues } = useUsbInverterConfiguration();
  const shouldBuy = createMemo(() => !stillFeedingIn() && !!chargingAmperageForBuying());
  const currentlyBuying = createMemo(() => $usbValues.ac_charge_battery !== "disabled");

  createEffect(() => {
    if (shouldBuy()) {
      if ($usbValues.ac_charge_battery !== "enabled") {
        setCommandQueue(prev => {
          // Remove any not yet executed commands regarding what we want to charge from
          const newQueue = new Set([...prev].filter(item => !item.command.startsWith("EDB")));
          newQueue.add({ command: "EDB1", onSucceeded: triggerGettingUsbValues });
          return newQueue;
        });
      }
    } else if (!chargingAmperageForBuying()) {
      if ($usbValues.ac_charge_battery !== "disabled") {
        setCommandQueue(prev => {
          // Remove any not yet executed commands regarding what we want to charge from
          const newQueue = new Set([...prev].filter(item => !item.command.startsWith("EDB")));
          newQueue.add({ command: "EDB0", onSucceeded: triggerGettingUsbValues });
          return newQueue;
        });
      }
    }
  });

  createEffect(() => {
    // When not buying, set to 10A in case the inverter glitches and charges from the grid even though disabled
    const wantedAmperes = shouldBuy() ? chargingAmperageForBuying() ?? 10 : 10;
    const targetDeciAmperes = Math.round(wantedAmperes * 10);
    setCommandQueue(prev => {
      // Remove any not yet executed commands regarding AC charging amperage
      const newQueue = new Set([...prev].filter(item => !item.command.startsWith("MUCHGC")));
      newQueue.add({
        command: `MUCHGC${(targetDeciAmperes + "").padStart(4, "0")}`,
      });
      return newQueue;
    });
  });

  useLogExpectedVsActualChargingAmperage(chargingAmperageForBuying, assumedParasiticConsumption);

  return { currentlyBuying };
}
