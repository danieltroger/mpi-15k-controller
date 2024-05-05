import { getBackendSyncedSignal } from "~/helpers/getBackendSyncedSignal";
import { createMemo, createSignal, onMount, Show } from "solid-js";
import { A } from "@solidjs/router";
import { InfoBroadcast } from "../../../backend/src/sharedTypes";

export default function Home() {
  const [info] = getBackendSyncedSignal<InfoBroadcast>("info");
  const [mqttValues] = getBackendSyncedSignal<Record<string, { value: any; time: number }>>("mqttValues");
  const [hasHydrated, setHasHydrated] = createSignal(false);
  const assumedCapacity = 19.2 * 12 * 3 * 16;
  const soc = createMemo(() => {
    const removedSinceFull = info()?.energyRemovedSinceFull;
    if (removedSinceFull === undefined) return undefined;
    return 100 - (removedSinceFull / assumedCapacity) * 100;
  });

  onMount(() => setHasHydrated(true));

  return (
    <main>
      <section>
        <h2>Links</h2>
        <ol>
          <li>
            <A href="/config">Config editor</A>
          </li>
          <li>
            <A href="/temperatures">Temperatures</A>
          </li>
        </ol>
      </section>
      <section>
        <h2>Info</h2>
        <pre>
          <code>
            <Show when={hasHydrated() && info()} fallback={"Loading…"}>
              {JSON.stringify(info(), null, 2)}
            </Show>
          </code>
        </pre>
        <br />
        Percent SOC assuming {assumedCapacity.toLocaleString()}wh capacity: {soc()}%
      </section>
      <Show when={hasHydrated()}>
        <NoBuyDebug mqttValues={mqttValues} />
      </Show>
      <section>
        <h2>MQTT Values</h2>
        <pre>
          <code>
            <Show when={hasHydrated() && mqttValues()} fallback={"Loading…"}>
              {JSON.stringify(mqttValues(), null, 2)}
            </Show>
          </code>
        </pre>
      </section>
    </main>
  );
}

function NoBuyDebug({ mqttValues }: { mqttValues: () => undefined | Record<string, { value: any; time: number }> }) {
  const solarPower = () =>
    ((mqttValues()?.["solar_input_power_1"]?.value || 0) as number) +
    ((mqttValues()?.["solar_input_power_2"]?.value || 0) as number);
  const acOutputPower = () =>
    ((mqttValues()?.["ac_output_active_power_r"]?.value || 0) as number) +
    ((mqttValues()?.["ac_output_active_power_s"]?.value || 0) as number) +
    ((mqttValues()?.["ac_output_active_power_t"]?.value || 0) as number);
  const availablePower = createMemo(() => solarPower() - acOutputPower());
  return (
    <section>
      <h2>Debug for no power buying</h2>
      <p>
        {availablePower()} watts, which is made out of {solarPower()} watts minus {acOutputPower()} watts
      </p>
    </section>
  );
}
