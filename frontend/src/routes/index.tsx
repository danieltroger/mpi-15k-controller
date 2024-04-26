import { getBackendSyncedSignal } from "~/helpers/getBackendSyncedSignal";
import { createMemo, createSignal, onMount, Show } from "solid-js";
import { A } from "@solidjs/router";
import { InfoBroadcast } from "../../../backend/src/sharedTypes";

export default function Home() {
  const [info] = getBackendSyncedSignal<InfoBroadcast>("info");
  const [mqttValues] = getBackendSyncedSignal("mqttValues");
  const [hasHydrated, setHasHydrated] = createSignal(false);
  const energyRemovedSinceFull = createMemo(() => {
    const discharged = info()?.energyDischargedSinceFull;
    const charged = info()?.energyChargedSinceFull;
    if (charged == undefined && discharged == undefined) return 0;
    if (charged == undefined) return discharged;
    if (discharged == undefined) return charged;
    return discharged + charged;
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
        Energy removed since full: {energyRemovedSinceFull()}wh
        <br />
        Percent SOC assuming 10 944wh capacity: {100 - Math.abs((energyRemovedSinceFull() / 10944) * 100)}%
      </section>
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
