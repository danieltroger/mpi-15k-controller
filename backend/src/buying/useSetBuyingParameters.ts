import { Accessor, createEffect, createMemo } from "solid-js";
import { get_config_object } from "../config";
import { useLogExpectedVsActualChargingAmperage } from "./useExpectedInputAmperage";

export function useSetBuyingParameters({
  configSignal,
  stillFeedingIn,
  chargingAmperageForBuying,
  assumedParasiticConsumption,
}: {
  stillFeedingIn: Accessor<boolean>;
  configSignal: Awaited<ReturnType<typeof get_config_object>>;
  chargingAmperageForBuying: Accessor<number | undefined>;
  assumedParasiticConsumption: Accessor<number>;
}) {
  const shouldBuy = createMemo(() => !stillFeedingIn() && !!chargingAmperageForBuying());
  const currentlyBuying = createMemo(() => currentChargeSourceValue() !== "PV Only");

  createEffect(() => {
    if (shouldBuy()) {
      setWantedChargeSourceValue("49");
    } else if (!chargingAmperageForBuying()) {
      setWantedChargeSourceValue("48");
    }
  });

  createEffect(() => {
    const wantedAmperage = chargingAmperageForBuying();
    if (shouldBuy()) {
      setWantedAcChargingCurrent(wantedAmperage!.toFixed(0));
    } else {
      // When not buying, set to 10A in case the inverter glitches and charges from the grid even though disabled
      setWantedAcChargingCurrent("10");
    }
  });

  useLogExpectedVsActualChargingAmperage(chargingAmperageForBuying, assumedParasiticConsumption);

  return { currentlyBuying };
}

/* Field description for charge source:
       {
        "id": "cts_ac_charge_battery_cmds",
        "name": "Charge source",
        "item": [
          {
            "key": "48",
            "val": "PV Only"
          },
          {
            "key": "49",
            "val": "PV and Grid"
          },
          {
            "key": "50",
            "val": "No charging"
          }
        ]
      }
    */
