import { A } from "@solidjs/router";
import { createMemo, For, Show } from "solid-js";
import { getBackendSyncedSignal } from "~/helpers/getBackendSyncedSignal";
import { formatRelativeTime, useNowMs } from "~/helpers/format";

import type { TemperatureReadingBroadcast } from "../../../../backend/src/sharedTypes";
import { temperatureStaleAfterMs } from "../../../../backend/src/temperatureMeasuring/thermometerSweepSettings";

/**
 * A thermometer that hasn't reported for this long (or three sweep intervals, when the sweeps are slower) gets
 * a gray dot — its value may be stale.
 */
const MIN_STALE_AFTER_MS = 3 * 60_000;

export function TemperatureChips() {
  const [temperatures] = getBackendSyncedSignal("temperatures");
  const [config] = getBackendSyncedSignal("config", undefined, false);
  const staleAfterMs = createMemo(() => temperatureStaleAfterMs(MIN_STALE_AFTER_MS, config()?.temperature_saving));
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
                <span class={`dot ${now() - reading.time > staleAfterMs() ? "" : "dot--ok"}`} aria-hidden="true"></span>
                {reading.label} <b>{reading.value.toFixed(1)}°</b>
              </span>
            )}
          </For>
        </div>
      </section>
    </Show>
  );
}
