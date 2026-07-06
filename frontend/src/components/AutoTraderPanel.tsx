import { createSignal, For, getOwner, Show } from "solid-js";
import { getBackendSyncedSignal, sendBackendAction } from "~/helpers/getBackendSyncedSignal";
import { showToastWithMessage } from "~/helpers/showToastWithMessage";
import { useWebSocket } from "~/components/WebSocketProvider";
import type { Config } from "../../../backend/src/config/config.types";

type StatusWindow = {
  start: string;
  end: string;
  watts: number;
  kind: "sell" | "buy";
  reason: string;
  expected_kwh: number;
  avg_spot: number;
};

type AutoTraderStatus = {
  enabled: boolean;
  note?: string;
  next_daily_run_at?: string;
  last_plan?: {
    generated_at: string;
    trigger: string;
    horizon_end: string;
    notes: string[];
    windows: StatusWindow[];
    projection: {
      minSocPercent: number;
      minSocAt: string;
      endSocPercent: number;
      plannedSellKwh: number;
      autoExportKwh: number;
      unavoidableImportKwh: number;
      plannedBuyKwh: number;
      estimatedRevenueSek: number;
      baselineRevenueSek: number;
    };
  };
  vetoes?: { start: string; end: string; kind: string }[];
  guard?: { last_run_at: string; last_action: string };
  last_error?: { at: string; message: string };
};

const fmtTime = (iso: string | undefined) =>
  iso
    ? new Date(iso).toLocaleString("sv-SE", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : "—";

export function AutoTraderPanel() {
  const [status] = getBackendSyncedSignal<AutoTraderStatus>("autoTraderStatus");
  const [config, setConfig] = getBackendSyncedSignal<Config>("config");
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

  const generateNow = async () => {
    setBusy(true);
    try {
      const result = await sendBackendAction(socket, "generate_trading_plan");
      await showToastWithMessage(owner, () => `Plan: ${result}`);
    } catch (e) {
      await showToastWithMessage(owner, () => `Failed: ${e}`);
    } finally {
      setBusy(false);
    }
  };

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

        <div class="buy-sell-config__grid2">
          <label class="buy-sell-config__label">
            Extra reserve to keep in battery (kWh), e.g. for car charging
            <input
              class="buy-sell-config__input"
              type="number"
              min="0"
              step="1"
              value={tradingConfig()?.extra_reserve_kwh ?? 0}
              onChange={e =>
                void writeTradingConfig({ extra_reserve_kwh: Math.max(0, parseFloat(e.currentTarget.value) || 0) })
              }
            />
          </label>
        </div>

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
              .join(", ")}
          </p>
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
