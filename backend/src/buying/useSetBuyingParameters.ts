import { type Accessor, createEffect, createMemo } from "solid-js";
import { useLogExpectedVsActualChargingAmperage } from "./useExpectedInputAmperage.ts";
import { useInverterComms } from "../inverterComms/InverterCommsProvider.ts";

export function useSetBuyingParameters({
  stillFeedingIn,
  chargingAmperageForBuying,
  idleConsumptionWatts,
}: {
  stillFeedingIn: Accessor<boolean>;
  chargingAmperageForBuying: Accessor<number | undefined>;
  idleConsumptionWatts: Accessor<number>;
}) {
  const { $usbValues, queueSetter } = useInverterComms();
  const shouldBuy = createMemo(() => !stillFeedingIn() && !!chargingAmperageForBuying());
  const currentlyBuying = createMemo(() => $usbValues.ac_charge_battery !== "disabled");

  createEffect(() => {
    // replacesPrefix "EDB" drops any queued-but-unsent opposite command so we can't flip-flop stale state
    if (shouldBuy()) {
      if ($usbValues.ac_charge_battery === "disabled") {
        queueSetter({ command: "EDB1", replacesPrefix: "EDB", refreshAfterSend: ["HECS"] });
      }
    } else if (!chargingAmperageForBuying()) {
      if ($usbValues.ac_charge_battery === "enabled") {
        queueSetter({ command: "EDB0", replacesPrefix: "EDB", refreshAfterSend: ["HECS"] });
      }
    }
  });

  createEffect(() => {
    // When not buying, set to 10A in case the inverter glitches and charges from the grid even though disabled
    const wantedAmperes = shouldBuy() ? chargingAmperageForBuying() ?? 10 : 10;
    const targetDeciAmperes = Math.round(wantedAmperes * 10);
    // replacesPrefix drops any queued-but-unsent AC charging amperage command for this newer target
    queueSetter({
      command: `MUCHGC${(targetDeciAmperes + "").padStart(4, "0")}`,
      replacesPrefix: "MUCHGC",
      refreshAfterSend: [],
    });
  });

  useLogExpectedVsActualChargingAmperage(chargingAmperageForBuying, idleConsumptionWatts);

  return { currentlyBuying };
}
