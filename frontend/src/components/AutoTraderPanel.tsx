import { createSignal, For, getOwner, Show } from "solid-js";
import { getBackendSyncedSignal, sendBackendAction } from "~/helpers/getBackendSyncedSignal";
import { showToastWithMessage } from "~/helpers/showToastWithMessage";
import { useWebSocket } from "~/components/WebSocketProvider";
import { formatKwh, formatSek, formatShortDateTime } from "~/helpers/format";
import type { Config } from "../../../backend/src/config/config.types";
import type { WsAction } from "../../../backend/src/wsContract.types";

const fmtTime = (iso: string | undefined) => (iso ? formatShortDateTime(iso) : "—");

export function AutoTraderPanel() {
  const [status] = getBackendSyncedSignal("autoTraderStatus");
  const [config, setConfig] = getBackendSyncedSignal("config");
  const socket = useWebSocket();
  const owner = getOwner()!;
  const [busy, setBusy] = createSignal(false);

  const tradingConfig = () => config()?.automatic_trading;

  const writeTradingConfig = async (patch: Partial<NonNullable<Config["automatic_trading"]>>) => {
    const current = config();
    if (!current?.automatic_trading) {
      await showToastWithMessage(owner, () => "Config not loaded yet");
      return;
    }
    await setConfig({ ...current, automatic_trading: { ...current.automatic_trading, ...patch } });
  };

  const runAction = async (action: WsAction, formatResult: (result: string) => string) => {
    setBusy(true);
    try {
      const result = await sendBackendAction(socket, action);
      await showToastWithMessage(owner, () => formatResult(result ?? "ok"));
    } catch (e) {
      await showToastWithMessage(owner, () => `Failed: ${e}`);
    } finally {
      setBusy(false);
    }
  };
  const generateNow = () => runAction("generate_trading_plan", result => `Plan: ${result}`);
  const clearVetoes = () => runAction("clear_trading_vetoes", result => result);

  return (
    <section class="buy-sell-config__section">
      <h2 class="buy-sell-config__subheading">Automatic trading</h2>
      <Show when={status()} fallback={<p class="buy-sell-config__hint">Waiting for backend…</p>}>
        <p class="buy-sell-config__hint">
          {status()!.enabled
            ? `Enabled — plans daily at ${tradingConfig()?.plan_at_local_time ?? "13:10"} when day-ahead prices publish. Next run: ${fmtTime(status()!.next_daily_run_at)}.`
            : "Disabled — the planner writes nothing until enabled."}
          {
            " Windows it creates appear in the schedules below and can be edited or deleted freely — edited windows become yours and are planned around; deleting one blocks trading in that time range."
          }
        </p>

        <Show when={status()!.last_plan}>
          {plan => (
            <>
              <p class="buy-sell-config__meta">
                Last plan: {fmtTime(plan().generated_at)} ({plan().trigger}), horizon until{" "}
                {fmtTime(plan().horizon_end)}. Projected: sell ~{plan().projection.plannedSellKwh} kWh (~
                {plan().projection.estimatedRevenueSek} SEK, baseline {plan().projection.baselineRevenueSek} SEK), min
                SOC {plan().projection.minSocPercent}% at {fmtTime(plan().projection.minSocAt)}.
              </p>
              <Show when={plan().windows.length} fallback={<p class="buy-sell-config__hint">No windows planned.</p>}>
                <div class="buy-sell-config__table-wrap">
                  <table class="buy-sell-config__table">
                    <thead>
                      <tr>
                        <th>What</th>
                        <th>When</th>
                        <th>Power</th>
                        <th>Why</th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={plan().windows}>
                        {w => (
                          <tr>
                            <td>{w.kind === "sell" ? "Sell" : "Buy"}</td>
                            <td>
                              {fmtTime(w.start)} → {fmtTime(w.end)}
                            </td>
                            <td>{w.watts} W</td>
                            <td>{w.reason}</td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </div>
              </Show>
              <Show when={plan().notes.length}>
                <p class="buy-sell-config__meta">{plan().notes.join(" · ")}</p>
              </Show>
            </>
          )}
        </Show>

        <Show when={status()!.vetoes?.length}>
          <p class="buy-sell-config__meta">
            Blocked ranges (you deleted planner windows there):{" "}
            {status()!
              .vetoes!.map(v => `${v.kind} ${fmtTime(v.start)}–${fmtTime(v.end)}`)
              .join(", ")}{" "}
            <button
              type="button"
              class="buy-sell-config__btn buy-sell-config__btn--secondary"
              disabled={busy()}
              onClick={() => void clearVetoes()}
            >
              {busy() ? "Working…" : "Unblock & replan"}
            </button>
          </p>
        </Show>
        <Show when={status()!.last_settlement}>
          {settlement => (
            <p class="buy-sell-config__meta">
              Realized {settlement().date}: exported {formatKwh(settlement().export_kwh)}, imported{" "}
              {formatKwh(settlement().import_kwh)} —{" "}
              <b class="buy-sell-config__earn">{formatSek(settlement().realized_revenue_sek, { signed: true })}</b> net
              from the grid (inverter-meter estimate, settled {fmtTime(settlement().settled_at)}).
            </p>
          )}
        </Show>
        <Show when={status()!.guard}>
          <p class="buy-sell-config__meta">
            Safety guard {fmtTime(status()!.guard!.last_run_at)}: {status()!.guard!.last_action}
          </p>
        </Show>
        <Show when={status()!.last_error}>
          <p class="buy-sell-config__form-error">
            Last error ({fmtTime(status()!.last_error!.at)}): {status()!.last_error!.message}
          </p>
        </Show>

        <div class="buy-sell-config__toolbar">
          <button
            type="button"
            class="buy-sell-config__btn buy-sell-config__btn--secondary"
            disabled={busy()}
            onClick={() => void generateNow()}
          >
            {busy() ? "Planning…" : "Generate plan now"}
          </button>
          <button
            type="button"
            class={`buy-sell-config__btn buy-sell-config__btn--${status()!.enabled ? "secondary" : "primary"}`}
            onClick={() => void writeTradingConfig({ enabled: !status()!.enabled })}
          >
            {status()!.enabled ? "Disable automatic trading" : "Enable automatic trading"}
          </button>
        </div>
      </Show>
    </section>
  );
}
