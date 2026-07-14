import { A } from "@solidjs/router";
import { createMemo, For, Show } from "solid-js";
import { getBackendSyncedSignal } from "~/helpers/getBackendSyncedSignal";
import { scheduleWindowsFromConfig, type ScheduleWindow } from "~/helpers/scheduleWindows";
import {
  formatClockTime,
  formatDayWord,
  formatSek,
  formatShortDateTime,
  formatSpotOre,
  formatWatts,
  useNowMs,
} from "~/helpers/format";
import type { Config } from "../../../../backend/src/config/config.types";
import type { AutoTraderStatus, StateWindow } from "../../../../backend/src/autoTrading/autoTraderState.types";

type UpcomingWindow = ScheduleWindow & { planned?: StateWindow };

/** "Yesterday" when the settled day really was yesterday, otherwise the date — settlement can lag. */
function settlementDayLabel(settledDate: string, nowMs: number): string {
  const yesterday = new Date(nowMs - 24 * 3600 * 1000).toLocaleDateString("sv-SE", { timeZone: "Europe/Stockholm" });
  if (settledDate === yesterday) return "Yesterday";
  return new Date(`${settledDate}T12:00:00`).toLocaleDateString("sv-SE", { day: "numeric", month: "short" });
}

export function NextUpCard() {
  const [status] = getBackendSyncedSignal("autoTraderStatus");
  const [config] = getBackendSyncedSignal("config", undefined, false);
  const now = useNowMs(30_000);

  // Windows from the config schedules (what will actually run), enriched with the planner's
  // reasoning where it was the author.
  const windows = createMemo<UpcomingWindow[]>(() =>
    scheduleWindowsFromConfig(config(), now()).map(window => ({
      ...window,
      planned: status()?.last_plan?.windows.find(
        planned => planned.kind === window.kind && +new Date(planned.start) === window.startMs
      ),
    }))
  );
  const current = createMemo(() => windows().find(window => window.startMs <= now()));
  const upcoming = createMemo(() => windows().filter(window => window.startMs > now()));
  const headline = createMemo(() => current() ?? upcoming()[0]);
  const rest = createMemo(() => upcoming().slice(current() ? 0 : 1, current() ? 2 : 3));

  const minSoc = createMemo(() => {
    const projection = status()?.last_plan?.projection;
    if (!projection || +new Date(projection.minSocAt) <= now()) return undefined;
    return projection;
  });

  const estimatedSek = (window: UpcomingWindow) => {
    if (!window.planned || window.kind !== "sell") return undefined;
    const bonus = config()?.automatic_trading?.sell_bonus_sek_per_kwh ?? 0;
    return window.planned.expected_kwh * (window.planned.avg_spot + bonus);
  };

  const windowTimeRange = (window: ScheduleWindow) =>
    `${formatDayWord(window.startMs, now())} ${formatClockTime(window.startMs)} – ${formatClockTime(window.endMs)}`;

  return (
    <section class="card next-card" aria-label="Next planned action">
      <div class="card-head">
        <span class="eyebrow">Next up · auto-trading {status() ? (status()!.enabled ? "on" : "off") : "…"}</span>
        <Show when={status()?.last_plan}>
          {plan => (
            <span class="card-meta" title={`Last plan ${formatShortDateTime(plan().generated_at)} (${plan().trigger})`}>
              planned {formatShortDateTime(plan().generated_at)}
            </span>
          )}
        </Show>
      </div>

      <Show
        when={headline()}
        fallback={
          <div class="next-card__none">
            <div class="next-card__main">Nothing scheduled</div>
            <p class="next-card__sub">
              {status()?.enabled
                ? "The planner found no profitable windows in the current horizon."
                : "Automatic trading is off — enable it or add windows on the Trading page."}
            </p>
          </div>
        }
      >
        {nextWindow => (
          <>
            <div class="next-card__main">
              {nextWindow().startMs <= now()
                ? nextWindow().kind === "sell"
                  ? "Selling"
                  : "Buying"
                : nextWindow().kind === "sell"
                  ? "Sell"
                  : "Buy"}{" "}
              {formatWatts(nextWindow().watts)}
            </div>
            <div class="next-card__when">
              {nextWindow().startMs <= now()
                ? `now, until ${formatClockTime(nextWindow().endMs)}`
                : windowTimeRange(nextWindow())}
            </div>
            <Show when={nextWindow().planned}>
              {planned => (
                <div class="next-card__sub">
                  {planned().reason} · avg {formatSpotOre(planned().avg_spot)}/kWh
                  <Show when={estimatedSek(nextWindow())}>
                    {sek => (
                      <>
                        {" "}
                        · est <b class="next-card__earn">{formatSek(sek(), { signed: true })}</b>
                      </>
                    )}
                  </Show>
                </div>
              )}
            </Show>
          </>
        )}
      </Show>

      <Show when={rest().length || minSoc()}>
        <div class="next-card__then">
          <For each={rest()}>
            {window => (
              <div class="next-card__then-row">
                <span class={`next-card__kind next-card__kind--${window.kind}`} aria-hidden="true"></span>
                <span>
                  <b>
                    {window.kind === "sell" ? "Sell" : "Buy"} {formatWatts(window.watts)}
                  </b>{" "}
                  · {windowTimeRange(window)}
                  <Show when={window.planned}>{planned => <> · {formatSpotOre(planned().avg_spot)}</>}</Show>
                </span>
              </div>
            )}
          </For>
          <Show when={minSoc()}>
            {projection => (
              <div class="next-card__then-row next-card__then-row--minsoc">
                <span>
                  SOC dips to <b>{projection().minSocPercent}%</b>{" "}
                  {formatDayWord(+new Date(projection().minSocAt), now())} {formatClockTime(projection().minSocAt)}
                </span>
              </div>
            )}
          </Show>
        </div>
      </Show>

      <div class="next-card__foot">
        <span>
          <Show when={status()?.last_settlement}>
            {settlement => (
              <span
                title={`Realized ${settlement().date}: exported ${settlement().export_kwh} kWh, imported ${settlement().import_kwh} kWh`}
              >
                {settlementDayLabel(settlement().date, now())}{" "}
                <b class="next-card__earn">{formatSek(settlement().realized_revenue_sek, { signed: true })}</b> ·{" "}
              </span>
            )}
          </Show>
          <Show when={status()?.next_daily_run_at} fallback="waiting for controller…">
            next plan {formatShortDateTime(status()!.next_daily_run_at!)}
          </Show>
        </span>
        <A href="/buy-sell">Trading →</A>
      </div>
    </section>
  );
}
