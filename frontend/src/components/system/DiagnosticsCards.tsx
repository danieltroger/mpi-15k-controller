import { createMemo, Show } from "solid-js";
import { getBackendSyncedSignal } from "~/helpers/getBackendSyncedSignal";
import {
  dashUnless,
  formatRelativeTime,
  formatShortDateTime,
  formatWatts,
  formatWhAsKwh,
  useNowMs,
} from "~/helpers/format";
import type { CurrentBatteryPowerBroadcast, MqttValue } from "../../../../backend/src/sharedTypes";
import type { Config } from "../../../../backend/src/config/config.types";
import type { LedgerAnchor } from "../../../../backend/src/battery/ahLedger.types";
import "./DiagnosticsCards.scss";

/**
 * The engineering view that used to be the landing page: SOC ledgers, raw hall-sensor readings and
 * the no-buy debug trail. Everything here is diagnostic — the human-facing summary lives on the
 * dashboard.
 */
export function DiagnosticsCards() {
  return (
    <div class="diag__grid">
      <SocLedgers />
      <CurrentSensors />
      <NoBuyDebug />
    </div>
  );
}

function DiagRow(props: { label: string; value: string; title?: string }) {
  return (
    <div class="diag__row" title={props.title}>
      <span class="diag__label">{props.label}</span>
      <span class="diag__value">{props.value}</span>
    </div>
  );
}

function SocLedgers() {
  const [socAh] = getBackendSyncedSignal("socAh");
  const [averageSOC] = getBackendSyncedSignal("averageSOC");
  const [latestAnchor] = getBackendSyncedSignal("latestAnchor");
  const [isCharging] = getBackendSyncedSignal("isCharging");
  const [line_power_direction] = getBackendSyncedSignal("line_power_direction");
  const [config] = getBackendSyncedSignal("config", undefined, false);
  const now = useNowMs(1000);
  const ahLedgerConfig = () => config()?.soc_calculations?.ah_ledger;
  // Usable capacity and idle draw are derived from the Ah ledger now (the Wh fitter's assumed
  // capacity / parasitic figures were deleted with it).
  const capacityWh = () => {
    const ledger = ahLedgerConfig();
    return ledger ? ledger.capacity_ah * ledger.v_discharge : undefined;
  };
  const idleWatts = () => {
    const ledger = ahLedgerConfig();
    return ledger ? ledger.drain_a * ledger.v_discharge : undefined;
  };

  return (
    <section class="card">
      <div class="card-head">
        <span class="eyebrow">SOC ledger</span>
      </div>
      <DiagRow label="SOC (clamped, drives trading)" value={dashUnless(averageSOC(), soc => `${soc.toFixed(2)}%`)} />
      <DiagRow
        label="SOC (raw Ah, unclamped → InfluxDB)"
        value={dashUnless(socAh(), soc => `${soc.toFixed(2)}%`)}
        title="The coulomb-counting SOC before clamping — the drift Grafana tracks"
      />
      <Show when={ahLedgerConfig()}>
        {ledger => (
          <DiagRow
            label="Ah ledger parameters"
            value={`${ledger().capacity_ah.toFixed(1)} Ah · drain ${ledger().drain_a.toFixed(2)} A`}
          />
        )}
      </Show>
      <DiagRow label="Usable capacity (capacity_ah × v_discharge)" value={dashUnless(capacityWh(), formatWhAsKwh)} />
      <DiagRow label="Idle draw (drain_a × v_discharge)" value={dashUnless(idleWatts(), formatWatts)} />
      <Show when={latestAnchor()}>
        {anchor => (
          <DiagRow
            label="Latest anchor"
            value={`${anchorLabel(anchor().type)} @ ${anchor().soc}% · ${formatShortDateTime(anchor().at)} (${formatRelativeTime(now(), anchor().at)})`}
          />
        )}
      </Show>
      <DiagRow label="isCharging (float workaround)" value={String(isCharging() ?? "—")} />
      <DiagRow label="line_power_direction (raw)" value={dashUnless(line_power_direction()?.value, String)} />
    </section>
  );
}

/** Human label for an anchor kind. */
function anchorLabel(type: LedgerAnchor["type"]): string {
  return type === "soft_empty" ? "soft-empty" : type;
}

function CurrentSensors() {
  const [voltageSagMillivoltsRaw] = getBackendSyncedSignal("voltageSagMillivoltsRaw");
  const [voltageSagMillivoltsAveraged] = getBackendSyncedSignal("voltageSagMillivoltsAveraged");
  const [voltageSagMillivoltsRaw2] = getBackendSyncedSignal("voltageSagMillivoltsRaw2");
  const [voltageSagMillivoltsAveraged2] = getBackendSyncedSignal("voltageSagMillivoltsAveraged2");
  const [config] = getBackendSyncedSignal("config", undefined, false);

  const currentFromMv = (
    millivolts: number | undefined,
    zeroKey: "zero_current_millivolts" | "zero_current_millivolts2",
    perAmpereKey: "millivolts_per_ampere" | "millivolts_per_ampere2"
  ) => {
    const measuring = config()?.current_measuring;
    if (millivolts === undefined || !measuring) return undefined;
    return (millivolts - measuring[zeroKey]) / measuring[perAmpereKey];
  };

  const formatAmps = (amps: number) => `${amps.toFixed(2)} A`;

  return (
    <section class="card">
      <div class="card-head">
        <span class="eyebrow">Battery current sensors</span>
      </div>
      <h3 class="diag__subhead">Sensor 1</h3>
      <DiagRow label="Raw" value={dashUnless(voltageSagMillivoltsRaw()?.value, mv => `${mv} mV`)} />
      <DiagRow
        label="Current from raw"
        value={dashUnless(
          currentFromMv(voltageSagMillivoltsRaw()?.value, "zero_current_millivolts", "millivolts_per_ampere"),
          formatAmps
        )}
      />
      <DiagRow label="Averaged" value={dashUnless(voltageSagMillivoltsAveraged(), mv => `${mv.toFixed(2)} mV`)} />
      <DiagRow
        label="Current from averaged"
        value={dashUnless(
          currentFromMv(voltageSagMillivoltsAveraged(), "zero_current_millivolts", "millivolts_per_ampere"),
          formatAmps
        )}
      />
      <h3 class="diag__subhead">Sensor 2 (positive pole)</h3>
      <DiagRow label="Raw" value={dashUnless(voltageSagMillivoltsRaw2()?.value, mv => `${mv} mV`)} />
      <DiagRow
        label="Current from raw"
        value={dashUnless(
          currentFromMv(voltageSagMillivoltsRaw2()?.value, "zero_current_millivolts2", "millivolts_per_ampere2"),
          formatAmps
        )}
      />
      <DiagRow label="Averaged" value={dashUnless(voltageSagMillivoltsAveraged2(), mv => `${mv.toFixed(2)} mV`)} />
      <DiagRow
        label="Current from averaged"
        value={dashUnless(
          currentFromMv(voltageSagMillivoltsAveraged2(), "zero_current_millivolts2", "millivolts_per_ampere2"),
          formatAmps
        )}
      />
    </section>
  );
}

function NoBuyDebug() {
  const [solar_input_power_1] = getBackendSyncedSignal("solar_input_power_1");
  const [solar_input_power_2] = getBackendSyncedSignal("solar_input_power_2");
  const [ac_output_active_power_r] = getBackendSyncedSignal("ac_output_active_power_r");
  const [ac_output_active_power_s] = getBackendSyncedSignal("ac_output_active_power_s");
  const [ac_output_active_power_t] = getBackendSyncedSignal("ac_output_active_power_t");
  const [lastFeedWhenNoSolarReason] = getBackendSyncedSignal("lastFeedWhenNoSolarReason");
  const [lastChangingFeedWhenNoSolarReason] = getBackendSyncedSignal("lastChangingFeedWhenNoSolarReason");
  const now = useNowMs(1000);

  const solarPower = createMemo(
    () => ((solar_input_power_1()?.value || 0) as number) + ((solar_input_power_2()?.value || 0) as number)
  );
  const acOutputPower = createMemo(
    () =>
      ((ac_output_active_power_r()?.value || 0) as number) +
      ((ac_output_active_power_s()?.value || 0) as number) +
      ((ac_output_active_power_t()?.value || 0) as number)
  );
  const availablePower = createMemo(() => solarPower() - acOutputPower());

  return (
    <section class="card">
      <div class="card-head">
        <span class="eyebrow">Feed / no-buy debug</span>
      </div>
      <DiagRow
        label="Available power (solar − AC out)"
        value={`${formatWatts(availablePower())} = ${formatWatts(solarPower())} − ${formatWatts(acOutputPower())}`}
      />
      <Show when={lastFeedWhenNoSolarReason()}>
        {reason => (
          <p class="diag__reason">
            <b>Last reason</b> ({formatRelativeTime(now(), reason().when)}): {reason().what}
          </p>
        )}
      </Show>
      <Show when={lastChangingFeedWhenNoSolarReason()}>
        {reason => (
          <p class="diag__reason">
            <b>Last changing reason</b> ({formatRelativeTime(now(), reason().when)}): {reason().what}
          </p>
        )}
      </Show>
    </section>
  );
}
