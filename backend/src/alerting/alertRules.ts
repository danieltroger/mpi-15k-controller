import { type Accessor, createEffect, createMemo, onCleanup, untrack } from "solid-js";
import type { Config } from "../config/config.types.ts";
import type { CurrentBatteryPowerBroadcast } from "../sharedTypes.ts";
import { mqttValueKeys } from "../sharedTypes.ts";
import type { useFromMqttProvider } from "../mqttValues/MQTTValuesProvider.ts";
import type { useTemperatures } from "../temperatureMeasuring/useTemperatures.ts";
import type { AutoTraderStatus } from "../autoTrading/autoTraderState.types.ts";
import type { AlertManager } from "./alertManager.ts";
import type { AlertSeverity } from "./alerting.types.ts";
import { formatSekForAlert, round1, thresholdState } from "./alertingLogic.ts";

/**
 * The watchers: each rule reads signals that already drive the rest of the controller and turns
 * threshold crossings into alerts. Rules own their hysteresis (set/clear gap via thresholdState)
 * so a value hovering at a threshold can't machine-gun pushes; the manager adds per-key cooldown
 * and rate caps on top.
 *
 * Deliberately NOT here: plan failures and other instrumented errors — every errorLog() in the
 * backend is already forwarded as a P2 by the manager, so those come for free.
 */
export function startAlertRules(ctx: {
  config: Accessor<Config>;
  manager: AlertManager;
  temperatures: ReturnType<typeof useTemperatures>;
  mqttValues: ReturnType<typeof useFromMqttProvider>["mqttValues"];
  averageSOC: Accessor<number | undefined>;
  currentBatteryPower: Accessor<CurrentBatteryPowerBroadcast | undefined>;
  autoTraderStatus: Accessor<AutoTraderStatus | undefined>;
}) {
  const bootedAtMs = Date.now();
  const alerting = createMemo(() => ctx.config().alerting);
  const inGracePeriod = () => Date.now() - bootedAtMs < untrack(alerting).startup_grace_seconds * 1000;

  /**
   * Rising edge fires the alert, falling edge (past the clear point) optionally sends a quiet P3
   * resolution. `next === undefined` means "inside the hysteresis gap — hold the current state".
   */
  const edgeAlert = (key: string, severity: AlertSeverity, options?: { resolveNotice?: boolean }) => {
    let active = false;
    return {
      update(next: boolean | undefined, title: string, message: () => string) {
        if (next === undefined || next === active) return;
        active = next;
        if (next) {
          void ctx.manager.raise({ key, severity, title, message: message() });
        } else if (options?.resolveNotice) {
          void ctx.manager.raise({
            key: `${key}:resolved`,
            severity: "P3",
            title: `Resolved: ${title}`,
            message: message(),
          });
        }
      },
    };
  };

  // ——— battery probe temperature (cells + bus bars; cooling_* probes sit on the inverter air path) ———
  const batteryProbes = createMemo(() =>
    Object.values(ctx.temperatures())
      .map(reading => reading())
      .filter(
        (reading): reading is NonNullable<typeof reading> =>
          !!reading && (reading.label.startsWith("cell") || reading.label.includes("bus_bar"))
      )
  );
  const batteryTempAlert = edgeAlert("battery-temp", "P1", { resolveNotice: true });
  createEffect(() => {
    const probes = batteryProbes();
    if (!probes.length) return;
    const hottest = probes.reduce((a, b) => (a.value >= b.value ? a : b));
    const threshold = alerting().battery_temp_p1_celsius;
    batteryTempAlert.update(
      thresholdState(hottest.value, threshold, threshold - 3),
      "Battery temperature high",
      () => `${hottest.label} at ${round1(hottest.value)}°C (P1 threshold ${threshold}°C)`
    );
  });

  // ——— inverter temperature (hard shutdown at 100 °C — the 97 °C threshold sits deliberately close) ———
  const inverterTempAlert = edgeAlert("inverter-temp", "P1", { resolveNotice: true });
  createEffect(() => {
    const reading = ctx.mqttValues.component_max_temperature;
    if (!reading) return;
    const threshold = alerting().inverter_temp_p1_celsius;
    inverterTempAlert.update(
      thresholdState(reading.value, threshold, threshold - 5),
      "Inverter near thermal shutdown",
      () => `component_max_temperature ${round1(reading.value)}°C — the inverter shuts off at 100°C`
    );
  });

  // ——— battery voltage window (16s LiFePO4: cells tolerate down to 2.5 V/cell = 40 V) ———
  const undervoltAlert = edgeAlert("battery-undervoltage", "P2", { resolveNotice: true });
  const overvoltAlert = edgeAlert("battery-overvoltage", "P1", { resolveNotice: true });
  createEffect(() => {
    const reading = ctx.mqttValues.battery_voltage;
    if (!reading) return;
    const limits = alerting();
    const low = limits.battery_undervoltage_p2_volts;
    const high = limits.battery_overvoltage_p1_volts;
    undervoltAlert.update(
      thresholdState(-reading.value, -low, -(low + 1)),
      "Battery voltage low",
      () => `${reading.value} V (P2 below ${low} V)`
    );
    overvoltAlert.update(
      thresholdState(reading.value, high, high - 0.4),
      "Battery voltage HIGH",
      () => `${reading.value} V (P1 above ${high} V) — check the charge cutoff`
    );
  });

  // ——— charging while frozen (LiFePO4 must not charge below ~0 °C) ———
  const chargingFrozenAlert = edgeAlert("charging-below-freezing", "P1");
  createEffect(() => {
    const probes = batteryProbes();
    const power = ctx.currentBatteryPower();
    if (!probes.length || !power) return;
    const coldest = probes.reduce((a, b) => (a.value <= b.value ? a : b));
    const limit = alerting().charging_battery_temp_p1_celsius;
    chargingFrozenAlert.update(
      power.value > 200 && coldest.value <= limit
        ? true
        : power.value < 100 || coldest.value > limit + 1
          ? false
          : undefined,
      "Charging a freezing battery",
      () => `Charging at ${Math.round(power.value)} W with ${coldest.label} at ${round1(coldest.value)}°C`
    );
  });

  // ——— SOC below the emergency floor while discharging (the guard should have prevented this) ———
  const socFloorAlert = edgeAlert("soc-floor-breach", "P2", { resolveNotice: true });
  createEffect(() => {
    const soc = ctx.averageSOC();
    const power = ctx.currentBatteryPower();
    const floor = ctx.config().automatic_trading?.emergency_soc_floor_percent;
    if (soc === undefined || !power || floor === undefined) return;
    socFloorAlert.update(
      soc < floor && power.value < -100 ? true : soc > floor + 3 || power.value > 100 ? false : undefined,
      "SOC below emergency floor",
      () => `averageSOC ${round1(soc)}% vs floor ${floor}% (battery ${Math.round(power.value)} W)`
    );
  });

  // ——— staleness + grid presence: time-based, so polled rather than reactive ———
  const staleMqttAlert = edgeAlert("mqtt-stale", "P2", { resolveNotice: true });
  const staleTemperaturesAlert = edgeAlert("temperatures-stale", "P2", { resolveNotice: true });
  const gridOutAlert = edgeAlert("grid-out", "P2", { resolveNotice: true });
  let gridLowSinceMs: number | undefined;
  const pollTimer = setInterval(() => {
    if (inGracePeriod()) return;
    const nowMs = Date.now();
    const limits = untrack(alerting);

    const newestMqttMs = Math.max(0, ...mqttValueKeys.map(key => untrack(() => ctx.mqttValues[key])?.time ?? 0));
    staleMqttAlert.update(
      newestMqttMs === 0 ? undefined : nowMs - newestMqttMs > limits.stale_mqtt_p2_minutes * 60_000,
      "Inverter data stale",
      () => `No mqtt updates for ${Math.round((nowMs - newestMqttMs) / 60_000)} min — USB reading daemon dead?`
    );

    const readings = untrack(() => Object.values(ctx.temperatures()).map(reading => reading()));
    const newestTempMs = Math.max(0, ...readings.map(reading => reading?.time ?? 0));
    staleTemperaturesAlert.update(
      newestTempMs === 0 ? undefined : nowMs - newestTempMs > limits.stale_temperatures_p2_minutes * 60_000,
      "Thermometers silent",
      () => `No temperature updates for ${Math.round((nowMs - newestTempMs) / 60_000)} min`
    );

    const gridVoltage = untrack(() => ctx.mqttValues.ac_input_voltage_r);
    const gridFresh = gridVoltage && nowMs - gridVoltage.time < 2 * 60_000;
    const gridLow = !!gridFresh && gridVoltage.value < limits.grid_out_below_volts;
    if (!gridLow) gridLowSinceMs = undefined;
    else gridLowSinceMs ??= nowMs;
    gridOutAlert.update(
      // stale grid reading → hold (the mqtt-stale rule owns that failure)
      !gridFresh ? undefined : gridLow && nowMs - gridLowSinceMs! >= limits.grid_out_p2_seconds * 1000,
      "Grid appears down",
      () =>
        `ac_input_voltage_r at ${gridVoltage?.value ?? "?"} V for ${Math.round((nowMs - (gridLowSinceMs ?? nowMs)) / 1000)} s — house is running on the battery`
    );
  }, 15_000);
  onCleanup(() => clearInterval(pollTimer));

  // ——— trader guard interventions + P3 digests (watched via the status signal — autoTrader.ts untouched) ———
  let previousGuardAction: string | undefined;
  createEffect(() => {
    const action = ctx.autoTraderStatus()?.guard?.last_action;
    const previous = previousGuardAction;
    previousGuardAction = action;
    // previous === undefined covers boot: the persisted last_action must not re-alert on restart
    if (action === undefined || previous === undefined || action === previous) return;
    if (action.startsWith("ok") || action.startsWith("nothing")) return;
    void ctx.manager.raise({ key: "trader-guard", severity: "P2", title: "Trading guard intervened", message: action });
  });

  let previousPlanGeneratedAt: string | undefined;
  createEffect(() => {
    const plan = ctx.autoTraderStatus()?.last_plan;
    const previous = previousPlanGeneratedAt;
    previousPlanGeneratedAt = plan?.generated_at;
    if (!plan || previous === undefined || plan.generated_at === previous) return;
    if (plan.trigger !== "daily" || !untrack(alerting).digest_p3) return;
    const projection = plan.projection;
    void ctx.manager.raise({
      key: "daily-plan-digest",
      severity: "P3",
      title: "Today's trading plan",
      message: `${plan.windows.length} window(s), sell ~${round1(projection.plannedSellKwh)} kWh, est ${formatSekForAlert(projection.estimatedRevenueSek)}, min SOC ${round1(projection.minSocPercent)}%`,
    });
  });

  let previousSettledDate: string | undefined;
  createEffect(() => {
    const settlement = ctx.autoTraderStatus()?.last_settlement;
    const previous = previousSettledDate;
    previousSettledDate = settlement?.date;
    if (!settlement || previous === undefined || settlement.date === previous) return;
    if (!untrack(alerting).digest_p3) return;
    void ctx.manager.raise({
      key: "settlement-digest",
      severity: "P3",
      title: `Settled ${settlement.date}`,
      message: `Realized ${formatSekForAlert(settlement.realized_revenue_sek)} (exported ${settlement.export_kwh} kWh, imported ${settlement.import_kwh} kWh)`,
    });
  });
}
