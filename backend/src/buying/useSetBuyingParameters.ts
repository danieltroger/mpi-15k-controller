import { type Accessor, createEffect, createMemo } from "solid-js";
import { useLogExpectedVsActualChargingAmperage } from "./useExpectedInputAmperage.ts";
import { useInverterComms } from "../inverterComms/InverterCommsProvider.ts";
import { wantedAcChargingLimitAmps } from "./buyWindowEndStepDown.ts";
import { useAcChargingLimitReadback } from "./useAcChargingLimitReadback.ts";
import { useBuyWindowEndStepDown } from "./useBuyWindowEndStepDown.ts";

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
  const wantedLimitAmps = createMemo(() => wantedAcChargingLimitAmps(shouldBuy(), chargingAmperageForBuying()));
  const acChargingLimitReadback = useAcChargingLimitReadback();
  // A window end first caps the charge current (the MUCHGC effect below) and holds EDB0 back until
  // that has taken effect: EDB0 at full current is what latched fault 14 three times (#53)
  const { holdsAcChargingOn } = useBuyWindowEndStepDown({
    chargingAmperageForBuying,
    wantedLimitAmps,
    acChargingLimitReadback,
  });

  createEffect(() => {
    // Desired state, queued even when the readback already matches: replacesPrefix "EDB" drops any
    // queued-but-unsent opposite command so stale state can't land later, and the session sends
    // nothing when the inverter already holds the wanted value
    if (!$usbValues.ac_charge_battery) return;
    if (shouldBuy() || holdsAcChargingOn()) {
      queueSetter({ command: "EDB1", replacesPrefix: "EDB", refreshAfterSend: ["HECS"] });
    } else if (!chargingAmperageForBuying()) {
      queueSetter({ command: "EDB0", replacesPrefix: "EDB", refreshAfterSend: ["HECS"] });
    }
  });

  createEffect(() => {
    // Re-queued on every BATS readback too: the session leaves re-sending a write whose confirm gave up
    // to its owner, and a window end's constant 10 A target would otherwise never re-run this effect
    acChargingLimitReadback();
    const targetDeciAmperes = Math.round(wantedLimitAmps() * 10);
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
