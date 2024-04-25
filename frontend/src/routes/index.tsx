import { getBackendSyncedSignal } from "~/helpers/getBackendSyncedSignal";
import { createSignal, onMount, Show } from "solid-js";

export default function Home() {
  const [info] = getBackendSyncedSignal("info");
  const [hasHydrated, setHasHydrated] = createSignal(false);
  onMount(() => setHasHydrated(true));

  return (
    <main>
      <pre>
        <code>
          <Show when={hasHydrated() && info()} fallback={"Loading…"}>
            {JSON.stringify(info(), null, 2)}
          </Show>
        </code>
      </pre>
    </main>
  );
}
