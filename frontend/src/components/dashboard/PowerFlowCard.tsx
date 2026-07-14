import { createMemo, Show } from "solid-js";
import { getBackendSyncedSignal } from "~/helpers/getBackendSyncedSignal";
import { dashUnless, formatWatts } from "~/helpers/format";
import type { CurrentBatteryPowerBroadcast, MqttValue } from "../../../../backend/src/sharedTypes";

/** Below this a connector renders idle — sensor noise, not a real flow. */
const IDLE_BAND_WATTS = 50;
/**
 * The four power readings never sum to exactly zero — the hall sensor's zero bias alone is
 * ~150 W and the mqtt values sample at different instants. Beyond this, something is genuinely
 * off (or a sensor is stale).
 */
const BALANCE_TOLERANCE_WATTS = 500;

/**
 * The classic energy-app flow figure: solar and grid on the left, house and battery on the right,
 * everything meeting in the inverter hub. Values are the same four numbers the live-data page
 * sums for its sanity check; the card-meta shows that balance so a broken sensor is visible here too.
 */
export function PowerFlowCard() {
  const [solar_input_power_1] = getBackendSyncedSignal("solar_input_power_1");
  const [solar_input_power_2] = getBackendSyncedSignal("solar_input_power_2");
  const [ac_output_total_active_power] = getBackendSyncedSignal("ac_output_total_active_power");
  const [ac_input_total_active_power] = getBackendSyncedSignal("ac_input_total_active_power");
  const [currentBatteryPower] = getBackendSyncedSignal("currentBatteryPower");

  const solarWatts = createMemo(() => {
    const array1 = solar_input_power_1()?.value;
    const array2 = solar_input_power_2()?.value;
    if (array1 === undefined && array2 === undefined) return undefined;
    return (array1 ?? 0) + (array2 ?? 0);
  });
  const houseWatts = () => ac_output_total_active_power()?.value;
  /** Inverter convention: positive = importing from grid, negative = exporting. */
  const gridWatts = () => ac_input_total_active_power()?.value;
  /** Positive = charging the battery. */
  const batteryWatts = () => currentBatteryPower()?.value;

  const balanceWatts = createMemo(() => {
    const solar = solarWatts();
    const house = houseWatts();
    const grid = gridWatts();
    const battery = batteryWatts();
    if (solar === undefined || house === undefined || grid === undefined || battery === undefined) return undefined;
    return Math.round(solar - battery - house + grid);
  });

  // A positive residual within ~12% of what flows into the inverter is conversion loss (≈90%
  // efficiency at full 15 kW tilt), not a broken sensor — label it as such instead of warning.
  const balanceDisplay = createMemo(() => {
    const residual = balanceWatts();
    if (residual === undefined) return undefined;
    if (Math.abs(residual) <= BALANCE_TOLERANCE_WATTS) return { text: "balance ✓", warn: false };
    const inflow = (solarWatts() ?? 0) + Math.max(0, -(batteryWatts() ?? 0)) + Math.max(0, gridWatts() ?? 0);
    if (residual > 0 && residual < inflow * 0.12) {
      return { text: `~${formatWatts(residual)} conversion loss`, warn: false };
    }
    return { text: `balance off by ${formatWatts(residual)}`, warn: true };
  });

  const batteryState = createMemo(() => {
    const watts = batteryWatts();
    if (watts === undefined) return "unknown";
    if (watts > IDLE_BAND_WATTS) return "charging";
    if (watts < -IDLE_BAND_WATTS) return "discharging";
    return "idle";
  });
  const gridState = createMemo(() => {
    const watts = gridWatts();
    if (watts === undefined) return "unknown";
    if (watts < -IDLE_BAND_WATTS) return "exporting";
    if (watts > IDLE_BAND_WATTS) return "importing";
    return "idle";
  });
  const solarActive = () => (solarWatts() ?? 0) > IDLE_BAND_WATTS;

  const flowLineClass = (active: boolean) => `flow-line${active ? "" : " flow-line--idle"}`;

  return (
    <section class="card flow-card" aria-label="Power flow">
      <div class="card-head">
        <span class="eyebrow">Power flow</span>
        <span
          class="card-meta"
          classList={{ "flow-card__balance-off": balanceDisplay()?.warn }}
          title="Solar minus battery charge minus house load plus grid import — near zero when idle; a positive residual under load is inverter conversion loss"
        >
          {balanceDisplay()?.text ?? "—"}
        </span>
      </div>
      <svg
        viewBox="0 0 380 212"
        role="img"
        aria-label={`Solar ${dashUnless(solarWatts(), formatWatts)}, house ${dashUnless(houseWatts(), formatWatts)}, battery ${batteryState()}, grid ${gridState()}`}
      >
        {/* connectors, drawn in flow direction so the dash animation travels the right way */}
        <path class={flowLineClass(solarActive())} stroke="var(--solar)" d="M88 52 C 130 52, 150 98, 190 98" />
        <path class={flowLineClass(true)} stroke="var(--ink-3)" d="M190 98 C 230 98, 250 52, 292 52" />
        <Show
          when={batteryState() === "discharging"}
          fallback={
            <path
              class={flowLineClass(batteryState() === "charging")}
              stroke="var(--battery)"
              d="M190 98 C 230 98, 250 144, 292 144"
            />
          }
        >
          <path class="flow-line" stroke="var(--battery)" d="M292 144 C 250 144, 230 98, 190 98" />
        </Show>
        <Show
          when={gridState() === "importing"}
          fallback={
            <path
              class={flowLineClass(gridState() === "exporting")}
              stroke="var(--grid)"
              d="M190 98 C 150 98, 130 144, 88 144"
            />
          }
        >
          <path class="flow-line" stroke="var(--grid)" d="M88 144 C 130 144, 150 98, 190 98" />
        </Show>
        <circle cx="190" cy="98" r="4.5" fill="var(--ink-2)" />

        {/* Solar */}
        <g>
          <circle cx="58" cy="52" r="24" fill="none" stroke="var(--solar)" stroke-width="1.8" />
          <g stroke="var(--solar)" stroke-width="1.6" stroke-linecap="round">
            <circle cx="58" cy="52" r="6" fill="none" />
            <path d="M58 41v-3M58 66v-3M69 52h3M44 52h3M66 44l2-2M48 62l2-2M66 60l2 2M48 42l2 2" fill="none" />
          </g>
          <text class="flow-card__label" x="58" y="15" text-anchor="middle">
            Solar
          </text>
          <text class="flow-card__value" x="58" y="94" text-anchor="middle">
            {dashUnless(solarWatts(), formatWatts)}
          </text>
        </g>
        {/* Grid */}
        <g>
          <circle cx="58" cy="144" r="24" fill="none" stroke="var(--grid)" stroke-width="1.8" />
          <g stroke="var(--grid)" stroke-width="1.6" stroke-linecap="round" fill="none">
            <path d="M52 154V136l6-4 6 4v18M52 141h12M52 147h12" />
          </g>
          {/* single expression: mixed static+dynamic text in SVG <text> crashes the solid babel plugin */}
          <text class="flow-card__value" x="58" y="187" text-anchor="middle">
            {dashUnless(gridWatts(), watts => formatWatts(Math.abs(watts)))}
          </text>
          <text class="flow-card__label" x="58" y="204" text-anchor="middle">
            {`Grid${gridState() === "exporting" ? " · exporting" : gridState() === "importing" ? " · importing" : ""}`}
          </text>
        </g>
        {/* House */}
        <g>
          <circle cx="322" cy="52" r="24" fill="none" stroke="var(--ink-2)" stroke-width="1.8" />
          <g stroke="var(--ink-2)" stroke-width="1.6" stroke-linecap="round" fill="none">
            <path d="M312 52l10-9 10 9M314 51v10h16V51" />
          </g>
          <text class="flow-card__label" x="322" y="15" text-anchor="middle">
            House
          </text>
          <text class="flow-card__value" x="322" y="94" text-anchor="middle">
            {dashUnless(houseWatts(), formatWatts)}
          </text>
        </g>
        {/* Battery */}
        <g>
          <circle cx="322" cy="144" r="24" fill="none" stroke="var(--battery)" stroke-width="1.8" />
          <g stroke="var(--battery)" stroke-width="1.6" stroke-linecap="round" fill="none">
            <rect x="311" y="139" width="18" height="10" rx="2" />
            <path d="M331 142v4" />
            <path d="M320 137l-3 5h5l-3 5" stroke-width="1.4" />
          </g>
          <text class="flow-card__value" x="322" y="187" text-anchor="middle">
            {dashUnless(batteryWatts(), watts => formatWatts(Math.abs(watts)))}
          </text>
          <text class="flow-card__label" x="322" y="204" text-anchor="middle">
            {`Battery${batteryState() === "charging" ? " · charging" : batteryState() === "discharging" ? " · discharging" : ""}`}
          </text>
        </g>
      </svg>
    </section>
  );
}
