import { getOwner, Show } from "solid-js";
import { getBackendSyncedSignal } from "~/helpers/getBackendSyncedSignal";
import { showToastWithMessage } from "~/helpers/showToastWithMessage";
import { dashUnless, formatRelativeTime, formatWatts, useNowMs } from "~/helpers/format";
import type { Config } from "../../../../backend/src/config/config.types";
import type { ElpatronDisplayState } from "../../../../backend/src/sharedTypes";

/**
 * The family-facing water heater control: Off (which really switches the element off) or
 * solar-driven with a configurable watt threshold. Live heater state comes from the heating pi
 * via the controller so what the card claims is what the element actually does.
 */
export function WaterHeaterCard() {
  const [config, setConfig] = getBackendSyncedSignal<Config>("config");
  const [elpatronState] = getBackendSyncedSignal<ElpatronDisplayState>("elpatronState", undefined, true, true);
  const owner = getOwner()!;
  const now = useNowMs(5000);
  const switching = () => config()?.elpatron_switching;

  const writeElpatronConfig = async (patch: Partial<Config["elpatron_switching"]>) => {
    const current = config();
    if (!current?.elpatron_switching) {
      await showToastWithMessage(owner, () => "Config not loaded yet");
      return;
    }
    await setConfig!({ ...current, elpatron_switching: { ...current.elpatron_switching, ...patch } });
  };

  return (
    <section class="card wh-card" aria-label="Water heater">
      <div class="card-head">
        <span class="eyebrow">Water heater</span>
        <span class="card-meta">
          {dashUnless(elpatronState()?.time, time => `checked ${formatRelativeTime(now(), time)}`)}
        </span>
      </div>
      <Show when={switching()} fallback={<p class="wh-card__hint">Waiting for controller…</p>}>
        {elpatron => (
          <>
            <span classList={{ chip: true, "chip--ok": elpatronState()?.heating === true }}>
              {elpatronState()?.heating === true
                ? `Heating · ~${formatWatts(elpatron().element_watts)}`
                : elpatronState()?.heating === false
                  ? "Not heating"
                  : "Status unknown"}
            </span>
            <div class="wh-card__modes" role="group" aria-label="Water heater mode">
              <button
                type="button"
                classList={{ "wh-card__mode": true, "wh-card__mode--active": !elpatron().enabled }}
                onClick={() => void writeElpatronConfig({ enabled: false })}
              >
                Off
              </button>
              <button
                type="button"
                classList={{ "wh-card__mode": true, "wh-card__mode--active": elpatron().enabled }}
                onClick={() => void writeElpatronConfig({ enabled: true })}
              >
                On when solar
              </button>
            </div>
            <Show
              when={elpatron().enabled}
              fallback={<p class="wh-card__hint">The element is switched off and stays off.</p>}
            >
              <p class="wh-card__hint">
                Heats when solar power exceeds{" "}
                <input
                  class="wh-card__watts"
                  type="number"
                  min="0"
                  step="50"
                  value={elpatron().min_solar_input}
                  onChange={event =>
                    void writeElpatronConfig({
                      min_solar_input: Math.max(0, Math.round(parseFloat(event.currentTarget.value) || 0)),
                    })
                  }
                />{" "}
                W and nothing is being imported from the grid.
              </p>
            </Show>
          </>
        )}
      </Show>
    </section>
  );
}
