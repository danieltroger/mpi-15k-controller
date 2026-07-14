import { A } from "@solidjs/router";
import { createMemo, For, Show } from "solid-js";
import { getBackendSyncedSignal } from "~/helpers/getBackendSyncedSignal";
import { formatRelativeTime, useNowMs } from "~/helpers/format";

import type { TemperatureReadingBroadcast } from "../../../../backend/src/sharedTypes";

/** A thermometer that hasn't reported for this long gets a gray dot — its value may be stale. */
const STALE_AFTER_MS = 3 * 60_000;

export function TemperatureChips() {
  const [temperatures] = getBackendSyncedSignal("temperatures");
  const now = useNowMs(5000);
  const readings = createMemo(() => Object.values(temperatures() ?? {}).sort((a, b) => a.label.localeCompare(b.label)));
  const newestTime = createMemo(() => Math.max(0, ...readings().map(reading => reading.time)));

  return (
    <Show when={readings().length}>
      <section class="card temps-card" aria-label="Temperatures">
        <div class="card-head">
          <span class="eyebrow">
            <A href="/temperatures">Temperatures</A>
          </span>
          <span class="card-meta">updated {formatRelativeTime(now(), newestTime())}</span>
        </div>
        <div class="temps-card__chips">
          <For each={readings()}>
            {reading => (
              <span
                class="temps-card__chip"
                title={`${reading.thermometer_device_id} · updated ${formatRelativeTime(now(), reading.time)}`}
              >
                <span class={`dot ${now() - reading.time > STALE_AFTER_MS ? "" : "dot--ok"}`} aria-hidden="true"></span>
                {reading.label} <b>{reading.value.toFixed(1)}°</b>
              </span>
            )}
          </For>
        </div>
      </section>
    </Show>
  );
}
