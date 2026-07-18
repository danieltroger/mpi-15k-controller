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
import type { LedgerAnchor } from "../../../../backend/src/battery/ahLedger.types";

const RING_RADIUS = 62;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export function BatteryCard() {
  // averageSOC is THE SOC the whole app runs on: the Ah ledger clamped to [0,100]. Capacity, idle draw
  // and the branch voltages come from the synced config's ah_ledger; latestAnchor is the last full/empty.
  const [averageSOC] = getBackendSyncedSignal("averageSOC");
  const [currentBatteryPower] = getBackendSyncedSignal("currentBatteryPower");
  const [latestAnchor] = getBackendSyncedSignal("latestAnchor");
  const [config] = getBackendSyncedSignal("config", undefined, false);
  const now = useNowMs(1000);

  const ahLedger = () => config()?.soc_calculations?.ah_ledger;
  // Inverter idle draw and usable pack energy, derived from the Ah ledger (drain_a / capacity_ah × v_discharge).
  const idleWatts = createMemo(() => {
    const ledger = ahLedger();
    return ledger ? ledger.drain_a * ledger.v_discharge : undefined;
  });
  const capacityWh = createMemo(() => {
    const ledger = ahLedger();
    return ledger ? ledger.capacity_ah * ledger.v_discharge : undefined;
  });

  const activity = useBatteryActivity({
    batteryPowerWatts: () => currentBatteryPower()?.value,
    idleWatts,
    socPercent: averageSOC,
    capacityAh: () => ahLedger()?.capacity_ah,
    vCharge: () => ahLedger()?.v_charge,
    vDischarge: () => ahLedger()?.v_discharge,
  });

  const socFraction = createMemo(() => Math.min(1, Math.max(0, (averageSOC() ?? 0) / 100)));
  const storedWh = createMemo(() => {
    const soc = averageSOC();
    const capacity = capacityWh();
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
            {dashUnless(storedWh(), stored => `${formatWhAsKwh(stored)} / ${formatWhAsKwh(capacityWh()!)}`)}
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
        {dashUnless(
          latestAnchor(),
          anchor => `last ${anchorLabel(anchor.type)} ${formatRelativeTime(now(), anchor.at)}`
        )}
      </div>
    </section>
  );
}

/** Human label for an anchor kind in the "last …" footer. */
function anchorLabel(type: LedgerAnchor["type"]): string {
  return type === "soft_empty" ? "soft-empty" : type;
}
