import { createMemo, For } from "solid-js";
import { getBackendSyncedSignal } from "~/helpers/getBackendSyncedSignal";
import { dashUnless, formatRelativeTime, formatWatts, useNowMs } from "~/helpers/format";
import type { CurrentBatteryPowerBroadcast, MqttValue } from "../../../../backend/src/sharedTypes";
import "./LiveReadings.scss";

/** Values older than this render dimmed — the sensor/broadcast behind them has gone quiet. */
const STALE_AFTER_MS = 60_000;

export function LiveReadings() {
  const [currentBatteryPower] = getBackendSyncedSignal<CurrentBatteryPowerBroadcast>("currentBatteryPower");
  const [battery_voltage] = getBackendSyncedSignal<MqttValue>("battery_voltage");
  const [battery_current] = getBackendSyncedSignal<MqttValue>("battery_current");
  const [solar_input_power_1] = getBackendSyncedSignal<MqttValue>("solar_input_power_1");
  const [solar_input_current_1] = getBackendSyncedSignal<MqttValue>("solar_input_current_1");
  const [solar_input_current_2] = getBackendSyncedSignal<MqttValue>("solar_input_current_2");
  const [solar_input_voltage_1] = getBackendSyncedSignal<MqttValue>("solar_input_voltage_1");
  const [solar_input_voltage_2] = getBackendSyncedSignal<MqttValue>("solar_input_voltage_2");
  const [solar_input_power_2] = getBackendSyncedSignal<MqttValue>("solar_input_power_2");
  const [ac_output_total_active_power] = getBackendSyncedSignal<MqttValue>("ac_output_total_active_power");
  const [ac_input_total_active_power] = getBackendSyncedSignal<MqttValue>("ac_input_total_active_power");
  const [ac_input_active_power_r] = getBackendSyncedSignal<MqttValue>("ac_input_active_power_r");
  const [ac_input_active_power_s] = getBackendSyncedSignal<MqttValue>("ac_input_active_power_s");
  const [ac_input_active_power_t] = getBackendSyncedSignal<MqttValue>("ac_input_active_power_t");
  const [ac_output_active_power_r] = getBackendSyncedSignal<MqttValue>("ac_output_active_power_r");
  const [ac_output_active_power_s] = getBackendSyncedSignal<MqttValue>("ac_output_active_power_s");
  const [ac_output_active_power_t] = getBackendSyncedSignal<MqttValue>("ac_output_active_power_t");
  const [ac_input_voltage_r] = getBackendSyncedSignal<MqttValue>("ac_input_voltage_r");
  const [ac_input_voltage_s] = getBackendSyncedSignal<MqttValue>("ac_input_voltage_s");
  const [ac_input_voltage_t] = getBackendSyncedSignal<MqttValue>("ac_input_voltage_t");
  const now = useNowMs(1000);

  const solarInput = createMemo(() => {
    const array1 = solar_input_power_1()?.value;
    const array2 = solar_input_power_2()?.value;
    if (array1 === undefined && array2 === undefined) return undefined;
    return (array1 ?? 0) + (array2 ?? 0);
  });

  const balance = createMemo(() => {
    const solar = solarInput();
    const batteryPower = currentBatteryPower()?.value;
    const acOutput = ac_output_total_active_power()?.value;
    const acInput = ac_input_total_active_power()?.value;
    if (solar == undefined || batteryPower == undefined || acOutput == undefined || acInput == undefined) {
      return undefined;
    }
    return Math.round(solar + batteryPower * -1 + acOutput * -1 + acInput);
  });

  const volts = (value: number) => `${value} V`;
  const amps = (value: number) => `${value} A`;
  const phaseWatts = (r: MqttValue | undefined, s: MqttValue | undefined, t: MqttValue | undefined) =>
    `R ${dashUnless(r?.value, formatWatts)} · S ${dashUnless(s?.value, formatWatts)} · T ${dashUnless(t?.value, formatWatts)}`;
  const derivedPhaseAmps = (power: MqttValue | undefined, voltage: MqttValue | undefined) => {
    const watts = power?.value;
    const phaseVoltage = voltage?.value;
    if (watts === undefined || phaseVoltage === undefined || !phaseVoltage) return undefined;
    return Math.round((watts / phaseVoltage) * 10) / 10;
  };

  const rows: { label: string; value: () => string; time: () => number | undefined; hint?: string }[] = [
    {
      label: "Solar array 1",
      value: () =>
        `${dashUnless(solar_input_voltage_1()?.value, volts)} · ${dashUnless(solar_input_current_1()?.value, amps)}`,
      time: () => solar_input_voltage_1()?.time,
    },
    {
      label: "Solar array 2",
      value: () =>
        `${dashUnless(solar_input_voltage_2()?.value, volts)} · ${dashUnless(solar_input_current_2()?.value, amps)}`,
      time: () => solar_input_voltage_2()?.time,
    },
    {
      label: "Solar power",
      value: () =>
        `${dashUnless(solarInput(), formatWatts)} (${dashUnless(solar_input_power_1()?.value, formatWatts)} + ${dashUnless(solar_input_power_2()?.value, formatWatts)})`,
      time: () => solar_input_power_1()?.time,
    },
    {
      label: "Battery power",
      value: () =>
        dashUnless(
          currentBatteryPower()?.value,
          watts => `${formatWatts(watts)} (${watts > 0 ? "charging" : "discharging"})`
        ),
      time: () => currentBatteryPower()?.time,
      hint: "From the hall sensor on the battery cable — positive charges the battery",
    },
    {
      label: "Battery voltage",
      value: () => dashUnless(battery_voltage()?.value, volts),
      time: () => battery_voltage()?.time,
    },
    {
      label: "Battery current (inverter)",
      value: () => dashUnless(battery_current()?.value, amps),
      time: () => battery_current()?.time,
    },
    {
      label: "House load (AC out)",
      value: () =>
        `${dashUnless(ac_output_total_active_power()?.value, formatWatts)} — ${phaseWatts(ac_output_active_power_r(), ac_output_active_power_s(), ac_output_active_power_t())}`,
      time: () => ac_output_total_active_power()?.time,
    },
    {
      label: "Grid (AC in)",
      value: () =>
        `${dashUnless(ac_input_total_active_power()?.value, watts => `${formatWatts(watts)} (${watts < 0 ? "exporting" : watts > 0 ? "importing" : "idle"})`)} — ${phaseWatts(ac_input_active_power_r(), ac_input_active_power_s(), ac_input_active_power_t())}`,
      time: () => ac_input_total_active_power()?.time,
    },
    {
      label: "Grid current per phase",
      value: () =>
        `R ${dashUnless(derivedPhaseAmps(ac_input_active_power_r(), ac_input_voltage_r()), amps)} · S ${dashUnless(derivedPhaseAmps(ac_input_active_power_s(), ac_input_voltage_s()), amps)} · T ${dashUnless(derivedPhaseAmps(ac_input_active_power_t(), ac_input_voltage_t()), amps)}`,
      time: () => ac_input_active_power_r()?.time,
      hint: "Computed as phase power / phase voltage",
    },
    {
      label: "Grid voltage per phase",
      value: () =>
        `R ${dashUnless(ac_input_voltage_r()?.value, volts)} · S ${dashUnless(ac_input_voltage_s()?.value, volts)} · T ${dashUnless(ac_input_voltage_t()?.value, volts)}`,
      time: () => ac_input_voltage_r()?.time,
    },
    {
      label: "Balance",
      value: () => dashUnless(balance(), formatWatts),
      time: () => undefined,
      hint: "Solar − battery − house + grid: near zero when every sensor is live and honest",
    },
  ];

  return (
    <section class="live-data" aria-label="Live readings">
      <table>
        <thead>
          <tr>
            <th>Reading</th>
            <th>Value</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          <For each={rows}>
            {row => {
              const time = createMemo(() => row.time());
              const isStale = createMemo(() => {
                const rowTime = time();
                return rowTime !== undefined && now() - rowTime > STALE_AFTER_MS;
              });
              return (
                <tr classList={{ "live-data__stale": isStale() }} title={row.hint}>
                  <td>{row.label}</td>
                  <td class="live-data__value">{row.value()}</td>
                  <td class="live-data__time" title={dashUnless(time(), ms => new Date(ms).toLocaleString())}>
                    {dashUnless(time(), ms => formatRelativeTime(now(), ms))}
                  </td>
                </tr>
              );
            }}
          </For>
        </tbody>
      </table>
    </section>
  );
}
