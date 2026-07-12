import { createSignal, For, getOwner, Show } from "solid-js";
import { getBackendSyncedSignal, sendBackendAction } from "~/helpers/getBackendSyncedSignal";
import { showToastWithMessage } from "~/helpers/showToastWithMessage";
import { useWebSocket } from "~/components/WebSocketProvider";
import { formatRelativeTime, useNowMs } from "~/helpers/format";
import type { AlertRecord } from "../../../../backend/src/alerting/alerting.types";
import type { Config } from "../../../../backend/src/config/config.types";
import "./AlertsCard.scss";

/**
 * Recent alerts as the controller saw them (including dry-run and suppressed ones), plus the test
 * button every family phone gets verified with. Thresholds live in the alerting config section.
 */
export function AlertsCard() {
  const [recentAlerts] = getBackendSyncedSignal<AlertRecord[]>("recentAlerts", undefined, true, true);
  const [config] = getBackendSyncedSignal<Config>("config", undefined, false);
  const socket = useWebSocket();
  const owner = getOwner()!;
  const now = useNowMs(5000);
  const [sending, setSending] = createSignal(false);

  const alertingConfig = () => config()?.alerting;

  return (
    <section class="card alerts-card" aria-label="Alerts">
      <div class="card-head">
        <span class="eyebrow">Alerts</span>
        <Show when={alertingConfig()}>
          {alerting => (
            <span class="card-meta">
              {alerting().dry_run
                ? "dry run — logging instead of pushing"
                : alerting().pushover_app_token
                  ? "pushing via Pushover"
                  : "no Pushover tokens configured"}
            </span>
          )}
        </Show>
      </div>

      <Show
        when={recentAlerts()?.length}
        fallback={<p class="alerts-card__empty">Nothing yet — quiet controller, happy controller.</p>}
      >
        <div class="alerts-card__list">
          <For each={recentAlerts()}>
            {alert => (
              <div class="alerts-card__row" title={alert.detail}>
                <span class={`alerts-card__severity alerts-card__severity--${alert.severity.toLowerCase()}`}>
                  {alert.severity}
                </span>
                <span class="alerts-card__text">
                  <b>{alert.title}</b> {alert.message}
                </span>
                <span class="alerts-card__meta">
                  {formatRelativeTime(now(), +new Date(alert.at))} · {alert.delivery}
                </span>
              </div>
            )}
          </For>
        </div>
      </Show>

      <button
        type="button"
        class="alerts-card__test-btn"
        disabled={sending()}
        onClick={async () => {
          setSending(true);
          try {
            const result = await sendBackendAction(socket, "send_test_alert");
            await showToastWithMessage(owner, () => `Test alert — ${result}`);
          } catch (e) {
            await showToastWithMessage(owner, () => `Test alert failed: ${e}`);
          } finally {
            setSending(false);
          }
        }}
      >
        {sending() ? "Sending…" : "Send test alert"}
      </button>
    </section>
  );
}
