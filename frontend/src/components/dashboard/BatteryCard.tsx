import { createMemo, Show } from "solid-js";
import { getBackendSyncedSignal } from "~/helpers/getBackendSyncedSignal";
import { useBatteryActivity } from "~/helpers/batteryActivity";
import {
  dashUnless,
  formatClockTime,
  formatDurationMs,
  formatRelativeTime,
  formatWatts,
  formatWhAsKwh,
  useNowMs,
} from "~/helpers/format";
import type { CurrentBatteryPowerBroadcast } from "../../../../backend/src/sharedTypes";

const RING_RADIUS = 62;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export function BatteryCard() {
  // averageSOC is the clamped SOC the trading logic actually runs on — the number that was
  // broadcast all along but shown nowhere before this card existed.
  const [averageSOC] = getBackendSyncedSignal("averageSOC");
  const [assumedCapacity] = getBackendSyncedSignal("assumedCapacity");
  const [currentBatteryPower] = getBackendSyncedSignal("currentBatteryPower");
  const [assumedParasiticConsumption] = getBackendSyncedSignal("assumedParasiticConsumption");
  const [energyRemovedSinceFull] = getBackendSyncedSignal("energyRemovedSinceFull");
  const [energyAddedSinceEmpty] = getBackendSyncedSignal("energyAddedSinceEmpty");
  const [totalLastFull] = getBackendSyncedSignal("totalLastFull");
  const [totalLastEmpty] = getBackendSyncedSignal("totalLastEmpty");
  const now = useNowMs(1000);

  const activity = useBatteryActivity({
    batteryPowerWatts: () => currentBatteryPower()?.value,
    parasiticWatts: assumedParasiticConsumption,
    whUntilFull: energyRemovedSinceFull,
    whUntilEmpty: energyAddedSinceEmpty,
  });

  const socFraction = createMemo(() => Math.min(1, Math.max(0, (averageSOC() ?? 0) / 100)));
  const storedWh = createMemo(() => {
    const soc = averageSOC();
    const capacity = assumedCapacity();
    if (soc === undefined || capacity === undefined) return undefined;
    return (soc / 100) * capacity;
  });

  return (
    <section class="card battery-card" aria-label="Battery state">
      <div class="card-head">
        <span class="eyebrow">Battery</span>
        <span class="card-meta">
          {dashUnless(currentBatteryPower()?.time, time => `updated ${formatRelativeTime(now(), time)}`)}
        </span>
      </div>
      <div class="battery-card__ring">
        <svg width="148" height="148" viewBox="0 0 148 148" aria-hidden="true">
          <circle cx="74" cy="74" r={RING_RADIUS} fill="none" stroke="var(--line-soft)" stroke-width="9" />
          <circle
            cx="74"
            cy="74"
            r={RING_RADIUS}
            fill="none"
            stroke="var(--battery)"
            stroke-width="9"
            stroke-linecap="round"
            stroke-dasharray={`${socFraction() * RING_CIRCUMFERENCE} ${RING_CIRCUMFERENCE}`}
            transform="rotate(-90 74 74)"
          />
        </svg>
        <div class="battery-card__ring-center">
          <div class="battery-card__soc">
            {dashUnless(averageSOC(), soc => soc.toFixed(0))}
            <small>%</small>
          </div>
          <div class="battery-card__kwh">
            {dashUnless(storedWh(), stored => `${formatWhAsKwh(stored)} / ${formatWhAsKwh(assumedCapacity()!)}`)}
          </div>
        </div>
      </div>

      <Show when={activity().state !== "unknown"} fallback={<span class="chip">Waiting for data…</span>}>
        <span
          classList={{
            chip: true,
            "chip--ok": activity().state === "charging",
          }}
        >
          <Show when={activity().state === "charging"}>▲ Charging · {formatWatts(activity().netWatts!)}</Show>
          <Show when={activity().state === "discharging"}>▼ Discharging · {formatWatts(-activity().netWatts!)}</Show>
          <Show when={activity().state === "idle"}>Idle</Show>
        </span>
      </Show>

      <Show when={activity().etaMs}>
        {etaMs => (
          <div class="battery-card__eta" title={new Date(etaMs()).toLocaleString()}>
            {activity().state === "charging" ? "Full" : "Empty"} around <b>{formatClockTime(etaMs())}</b>{" "}
            <span class="battery-card__eta-dim">(in {formatDurationMs(etaMs() - now())})</span>
          </div>
        )}
      </Show>

      <div class="battery-card__history">
        last full {dashUnless(totalLastFull(), iso => formatRelativeTime(now(), +new Date(iso)))} · last empty{" "}
        {dashUnless(totalLastEmpty(), ms => formatRelativeTime(now(), ms))}
      </div>
    </section>
  );
}
