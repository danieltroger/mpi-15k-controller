import { getBackendSyncedSignal } from "~/helpers/getBackendSyncedSignal";
import { createSignal, onMount, Show } from "solid-js";
import { A } from "@solidjs/router";

export default function Home() {
  const [info] = getBackendSyncedSignal("info");
  const [mqttValues] = getBackendSyncedSignal("mqttValues");
  const [hasHydrated, setHasHydrated] = createSignal(false);
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
