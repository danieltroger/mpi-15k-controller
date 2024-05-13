import { Title } from "@solidjs/meta";
import { getBackendSyncedSignal } from "~/helpers/getBackendSyncedSignal";
import { CurrentBatteryPowerBroadcast } from "../../../backend/src/sharedTypes";

export default function ParasiticPlayground() {
  const [mqttValues] = getBackendSyncedSignal<Record<string, { value: any; time: number }>>("mqttValues");
  const [currentPower] = getBackendSyncedSignal<CurrentBatteryPowerBroadcast>("currentBatteryPower");

  return (
    <main>
      <Title>Parasitic playground</Title>
      <h1>Parasitic playground</h1>
    </main>
  );
}
