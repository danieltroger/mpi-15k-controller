import { createMemo, createSignal, For, Show } from "solid-js";
import { getBackendSyncedSignal } from "~/helpers/getBackendSyncedSignal";
import { scheduleWindowsFromConfig } from "~/helpers/scheduleWindows";
import {
  formatClockTime,
  formatDayWord,
  formatRelativeTime,
  formatSpotOre,
  formatWatts,
  useNowMs,
} from "~/helpers/format";
import type { FetchedPrices } from "../../../backend/src/autoTrading/priceService.types";
import type { Config } from "../../../backend/src/config/config.types";
import type { AutoTraderStatus } from "../../../backend/src/autoTrading/autoTraderState.types";
import "./PricePlanChart.scss";

/** Mirrors the backend planner's SLOT_MS (planner.ts is a runtime module the frontend can't import). */
const SLOT_MS = 15 * 60_000;

const VIEW_W = 1000;
const VIEW_H = 240;
const PAD_L = 46;
const PAD_R = 14;
const PAD_T = 30;
const PAD_B = 40;
const PLOT_W = VIEW_W - PAD_L - PAD_R;
const PLOT_H = VIEW_H - PAD_T - PAD_B;

/**
 * The day-ahead spot price curve with the schedule's sell/buy windows shaded onto it — answers
 * "why is it selling at 20:00?" at a glance. Windows come from the config schedules (the source of
 * truth for what will run); min-SOC and the price series need the trading-aware backend.
 */
export function PricePlanChart() {
  const [spotPrices] = getBackendSyncedSignal<FetchedPrices>("spotPrices", undefined, true, true);
  const [config] = getBackendSyncedSignal<Config>("config", undefined, false);
  const [status] = getBackendSyncedSignal<AutoTraderStatus>("autoTraderStatus");
  const now = useNowMs(30_000);
  const [hoverIndex, setHoverIndex] = createSignal<number>();
  let svgElement: SVGSVGElement | undefined;

  const slots = () => spotPrices()?.slots ?? [];

  const geometry = createMemo(() => {
    const priceSlots = slots();
    if (priceSlots.length < 2) return undefined;
    const domainStart = priceSlots[0].startMs;
    const domainEnd = priceSlots[priceSlots.length - 1].startMs + SLOT_MS;
    const maxOre = Math.max(10, ...priceSlots.map(slot => slot.spot * 100)) * 1.12;
    const minOreRaw = Math.min(0, ...priceSlots.map(slot => slot.spot * 100));
    const step = [5, 10, 20, 25, 50, 100, 200, 500].find(candidate => maxOre / candidate <= 4.5) ?? 500;
    const yMaxOre = Math.ceil(maxOre / step) * step;
    const yMinOre = minOreRaw < 0 ? -Math.ceil((-minOreRaw * 1.12) / step) * step : 0;
    const x = (ms: number) => PAD_L + ((ms - domainStart) / (domainEnd - domainStart)) * PLOT_W;
    const y = (ore: number) => PAD_T + PLOT_H - ((ore - yMinOre) / (yMaxOre - yMinOre)) * PLOT_H;
    return { domainStart, domainEnd, x, y, yMaxOre, yMinOre, step };
  });

  const pricePath = createMemo(() => {
    const geo = geometry();
    if (!geo) return undefined;
    const priceSlots = slots();
    let path = `M${geo.x(priceSlots[0].startMs).toFixed(1)} ${geo.y(priceSlots[0].spot * 100).toFixed(1)}`;
    for (let i = 0; i < priceSlots.length; i++) {
      const slotEndX = geo.x(priceSlots[i].startMs + SLOT_MS);
      path += `H${slotEndX.toFixed(1)}`;
      if (i + 1 < priceSlots.length && priceSlots[i + 1].spot !== priceSlots[i].spot) {
        path += `V${geo.y(priceSlots[i + 1].spot * 100).toFixed(1)}`;
      }
    }
    return path;
  });

  const bands = createMemo(() => {
    const geo = geometry();
    if (!geo) return [];
    return scheduleWindowsFromConfig(config(), geo.domainStart)
      .filter(window => window.startMs < geo.domainEnd)
      .map(window => {
        const fromX = geo.x(Math.max(window.startMs, geo.domainStart));
        const toX = geo.x(Math.min(window.endMs, geo.domainEnd));
        return { ...window, fromX, toX, width: toX - fromX };
      });
  });

  const hourTicks = createMemo(() => {
    const geo = geometry();
    if (!geo) return { labels: [], dayDividers: [], dayLabels: [] };
    const labels: { x: number; text: string }[] = [];
    const dayDividers: number[] = [];
    const dayLabels: { x: number; text: string }[] = [];
    let dayStartMs = geo.domainStart;
    for (let ms = Math.ceil(geo.domainStart / 3600_000) * 3600_000; ms <= geo.domainEnd; ms += 3600_000) {
      const localHour = new Date(ms).getHours();
      if (localHour === 0 && ms > geo.domainStart && ms < geo.domainEnd) {
        dayDividers.push(geo.x(ms));
        dayLabels.push({
          x: geo.x((dayStartMs + ms) / 2),
          text: new Date(dayStartMs).toLocaleDateString("sv-SE", { weekday: "short", day: "numeric", month: "short" }),
        });
        dayStartMs = ms;
      }
      if (localHour % 6 === 0 && localHour !== 0 && ms < geo.domainEnd) {
        labels.push({ x: geo.x(ms), text: String(localHour).padStart(2, "0") });
      }
    }
    dayLabels.push({
      x: geo.x((dayStartMs + geo.domainEnd) / 2),
      text: new Date(dayStartMs).toLocaleDateString("sv-SE", { weekday: "short", day: "numeric", month: "short" }),
    });
    return { labels, dayDividers, dayLabels };
  });

  const yTicks = createMemo(() => {
    const geo = geometry();
    if (!geo) return [];
    const ticks: number[] = [];
    for (let ore = geo.yMinOre; ore <= geo.yMaxOre; ore += geo.step) ticks.push(ore);
    return ticks;
  });

  const minSocMarker = createMemo(() => {
    const geo = geometry();
    const projection = status()?.last_plan?.projection;
    if (!geo || !projection) return undefined;
    const ms = +new Date(projection.minSocAt);
    if (!isFinite(ms) || ms < geo.domainStart || ms > geo.domainEnd) return undefined;
    return { x: geo.x(ms), label: `min SOC ${projection.minSocPercent}%` };
  });

  const nowX = createMemo(() => {
    const geo = geometry();
    if (!geo || now() < geo.domainStart || now() > geo.domainEnd) return undefined;
    return geo.x(now());
  });

  const hovered = createMemo(() => {
    const index = hoverIndex();
    const geo = geometry();
    if (index === undefined || !geo) return undefined;
    const slot = slots()[index];
    if (!slot) return undefined;
    const band = bands().find(
      candidate => slot.startMs < candidate.endMs && slot.startMs + SLOT_MS > candidate.startMs
    );
    return {
      x: geo.x(slot.startMs + SLOT_MS / 2),
      y: geo.y(slot.spot * 100),
      timeLabel: `${formatDayWord(slot.startMs, now())} ${formatClockTime(slot.startMs)}–${formatClockTime(slot.startMs + SLOT_MS)}`,
      priceLabel: `${formatSpotOre(slot.spot)}/kWh`,
      band,
    };
  });

  const handlePointerMove = (event: PointerEvent) => {
    const geo = geometry();
    if (!geo || !svgElement) return;
    const rect = svgElement.getBoundingClientRect();
    const viewX = ((event.clientX - rect.left) / rect.width) * VIEW_W;
    const ms = geo.domainStart + ((viewX - PAD_L) / PLOT_W) * (geo.domainEnd - geo.domainStart);
    const index = Math.floor((ms - geo.domainStart) / SLOT_MS);
    setHoverIndex(index >= 0 && index < slots().length ? index : undefined);
  };

  return (
    <section class="card price-chart" aria-label="Spot price and planned trading windows">
      <div class="card-head">
        <span class="eyebrow">Spot price &amp; plan</span>
        <span class="price-chart__legend" aria-hidden="true">
          <i class="price-chart__swatch price-chart__swatch--sell"></i> sell
          <i class="price-chart__swatch price-chart__swatch--buy"></i> buy
        </span>
        <span class="card-meta">
          <Show when={spotPrices()} fallback="öre/kWh">
            {prices => `öre/kWh · fetched ${formatRelativeTime(now(), prices().fetchedAtMs)}`}
          </Show>
        </span>
      </div>
      <Show
        when={geometry()}
        fallback={
          <p class="price-chart__empty">
            Waiting for spot prices from the controller — this needs the backend version with the
            <code> spotPrices</code> feed.
          </p>
        }
      >
        {geo => (
          <div class="price-chart__holder">
            <svg
              ref={svgElement}
              viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
              preserveAspectRatio="xMidYMid meet"
              onPointerMove={handlePointerMove}
              onPointerLeave={() => setHoverIndex(undefined)}
              role="img"
              aria-label="Electricity spot price for today and tomorrow with scheduled sell and buy windows shaded"
            >
              {/* plan window bands under everything */}
              <For each={bands()}>
                {band => (
                  <g>
                    <rect
                      x={band.fromX}
                      y={PAD_T}
                      width={band.width}
                      height={PLOT_H}
                      rx="3"
                      class={`price-chart__band price-chart__band--${band.kind}`}
                    />
                    <Show when={band.width > 55}>
                      <text
                        x={band.fromX + band.width / 2}
                        y={PAD_T - 8}
                        text-anchor="middle"
                        class={`price-chart__band-label price-chart__band-label--${band.kind}`}
                      >
                        {`${band.kind === "sell" ? "Sell" : "Buy"} ${formatWatts(band.watts)}`}
                      </text>
                    </Show>
                  </g>
                )}
              </For>

              {/* y grid */}
              <For each={yTicks()}>
                {ore => (
                  <g>
                    <line
                      x1={PAD_L}
                      x2={VIEW_W - PAD_R}
                      y1={geo().y(ore)}
                      y2={geo().y(ore)}
                      class="price-chart__grid"
                    />
                    <text x={PAD_L - 7} y={geo().y(ore) + 3} text-anchor="end" class="price-chart__tick">
                      {ore}
                    </text>
                  </g>
                )}
              </For>
              <text x={PAD_L - 7} y={PAD_T - 10} text-anchor="end" class="price-chart__tick">
                öre
              </text>

              {/* x axis: hour ticks, day dividers + labels */}
              <For each={hourTicks().labels}>
                {tick => (
                  <text x={tick.x} y={PAD_T + PLOT_H + 15} text-anchor="middle" class="price-chart__tick">
                    {tick.text}
                  </text>
                )}
              </For>
              <For each={hourTicks().dayDividers}>
                {dividerX => (
                  <line x1={dividerX} x2={dividerX} y1={PAD_T} y2={PAD_T + PLOT_H + 6} class="price-chart__divider" />
                )}
              </For>
              <For each={hourTicks().dayLabels}>
                {day => (
                  <text x={day.x} y={PAD_T + PLOT_H + 31} text-anchor="middle" class="price-chart__day">
                    {day.text.toUpperCase()}
                  </text>
                )}
              </For>

              {/* price curve */}
              <path
                d={`${pricePath()!} V${geo().y(Math.max(0, geo().yMinOre)).toFixed(1)} H${PAD_L} Z`}
                class="price-chart__area"
              />
              <path d={pricePath()!} class="price-chart__line" />

              {/* min-SOC marker on the baseline */}
              <Show when={minSocMarker()}>
                {marker => (
                  <g>
                    <path d={`M${marker().x} ${PAD_T + PLOT_H + 2} l -4 6 h 8 Z`} fill="var(--ink-3)" />
                    <text x={marker().x - 6} y={PAD_T + PLOT_H - 6} text-anchor="end" class="price-chart__minsoc">
                      {marker().label}
                    </text>
                  </g>
                )}
              </Show>

              {/* now marker */}
              <Show when={nowX()}>
                {x => (
                  <g>
                    <line x1={x()} x2={x()} y1={PAD_T - 2} y2={PAD_T + PLOT_H} class="price-chart__now" />
                    {/* one template-literal expression: static text mixed with an expression inside
                        an SVG <text> crashes babel-plugin-jsx-dom-expressions 0.37 in dom mode */}
                    <text x={x() + 5} y={PAD_T + 8} class="price-chart__now-label">
                      {`now ${formatClockTime(now())}`}
                    </text>
                  </g>
                )}
              </Show>

              {/* hover crosshair */}
              <Show when={hovered()}>
                {hover => (
                  <g>
                    <line x1={hover().x} x2={hover().x} y1={PAD_T} y2={PAD_T + PLOT_H} class="price-chart__crosshair" />
                    <circle cx={hover().x} cy={hover().y} r="4" class="price-chart__marker" />
                  </g>
                )}
              </Show>
            </svg>
            <Show when={hovered()}>
              {hover => (
                <div
                  class="price-chart__tooltip"
                  style={{
                    left: `${Math.min(88, Math.max(10, (hover().x / VIEW_W) * 100))}%`,
                    top: `${(hover().y / VIEW_H) * 100}%`,
                  }}
                >
                  <div class="price-chart__tooltip-time">{hover().timeLabel}</div>
                  <div class="price-chart__tooltip-price">{hover().priceLabel}</div>
                  <Show when={hover().band}>
                    {band => (
                      <div class={`price-chart__tooltip-plan price-chart__tooltip-plan--${band().kind}`}>
                        {band().kind === "sell" ? "Sell" : "Buy"} {formatWatts(band().watts)} scheduled
                      </div>
                    )}
                  </Show>
                </div>
              )}
            </Show>
          </div>
        )}
      </Show>
    </section>
  );
}
