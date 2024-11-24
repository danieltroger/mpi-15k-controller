import { Accessor, createEffect, createMemo } from "solid-js";
import { useShinemonitorParameter } from "../useShinemonitorParameter";
import { get_config_object } from "../config";
import { useLogExpectedVsActualChargingAmperage } from "./useExpectedInputAmperage";
import { exec } from "../utilities/exec";

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
  const setWantedAcChargingCurrent = (newValue: number) => {
    exec(`mpp-solar -p /dev/hidraw0 -P PI17  -c MUCHGC${(Math.round(newValue * 10) + "").padStart(4, "0")}`);
  };
  const { setWantedValue: setWantedChargeSourceValue, currentValue: currentChargeSourceValue } =
    useShinemonitorParameter<"PV Only" | "PV and Grid", "48" | "49">({
      parameter: "cts_ac_charge_battery_cmds",
      configSignal,
      wantedToCurrentTransformerForDiffing: (wanted: string) => {
        if (wanted === "48") {
          return "PV Only" as const;
        } else if (wanted === "49") {
          return "PV and Grid" as const;
        }
        // Little lie so this function can fall-through in case we get in an unexpected value
        return wanted as "PV Only";
      },
    });
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
      setWantedAcChargingCurrent(wantedAmperage!);
    } else {
      // When not buying, set to 10A in case the inverter glitches and charges from the grid even though disabled
      setWantedAcChargingCurrent(10);
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
