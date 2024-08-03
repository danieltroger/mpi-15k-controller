import { Title } from "@solidjs/meta";
import { getBackendSyncedSignal } from "~/helpers/getBackendSyncedSignal";
import { CurrentBatteryPowerBroadcast, MqttValue } from "../../../backend/src/sharedTypes";
import "./live-data.scss";
import { createMemo } from "solid-js";

export default function LiveData() {
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
  const [ac_input_voltage_s] = getBackendSyncedSignal<MqttValue>("ac_input_voltage_r");
  const [ac_input_voltage_t] = getBackendSyncedSignal<MqttValue>("ac_input_voltage_r");
  const solarInput = createMemo(() => (solar_input_power_1()?.value || 0) + (solar_input_power_2()?.value || 0));
  const battery = createMemo(() => {
    const value = currentBatteryPower()?.value;
    if (value != undefined) return Math.round(value * -1);
  });
  const ac_output = createMemo(() => {
    const value = ac_output_total_active_power()?.value;
    if (value != undefined) return value * -1;
  });
  const ac_input = createMemo(() => ac_input_total_active_power()?.value);

  const sum = createMemo(() => {
    const solar = solarInput();
    const batteryPower = battery();
    const acOutput = ac_output();
    const acInput = ac_input();
    if (solar == undefined || batteryPower == undefined || acOutput == undefined || acInput == undefined) {
      return undefined;
    }
    return Math.round(solar + batteryPower + acOutput + acInput);
  });

  return (
    <main class="live-data">
      <Title>Live data</Title>
      <h1>Live data</h1>
      <table>
        <thead>
          <tr>
            <th>Parameter</th>
            <th>Value</th>
            <th>Time</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Solar array 1</td>
            <td>
              {(solar_input_voltage_1()?.value as number) / 10 + ""}v /{" "}
              {(solar_input_current_1()?.value as number) / 100 + ""}a
            </td>
            <td>
              {solar_input_voltage_1()?.time && new Date(solar_input_voltage_1()!.time).toLocaleString()} /{" "}
              {solar_input_current_1()?.time && new Date(solar_input_current_1()!.time).toLocaleString()}
            </td>
          </tr>
          <tr>
            <td>Solar array 2</td>
            <td>
              {(solar_input_voltage_2()?.value as number) / 10 + ""}v /{" "}
              {(solar_input_current_2()?.value as number) / 100 + ""}a
            </td>
            <td>
              {solar_input_voltage_2()?.time && new Date(solar_input_voltage_2()!.time).toLocaleString()} /{" "}
              {solar_input_current_2()?.time && new Date(solar_input_current_2()!.time).toLocaleString()}
            </td>
          </tr>
          <tr>
            <td>Current battery power</td>
            <td>{battery() + ""}w</td>
            <td>{currentBatteryPower()?.time && new Date(currentBatteryPower()!.time).toLocaleString()}</td>
          </tr>
          <tr>
            <td>Battery voltage</td>
            <td>{(battery_voltage()?.value && (battery_voltage()?.value as number) / 10) + ""}v</td>
            <td>{battery_voltage()?.time && new Date(battery_voltage()!.time).toLocaleString()}</td>
          </tr>
          <tr>
            <td>Battery current</td>
            <td>{(battery_current()?.value && (battery_current()?.value as number) / 10) + ""}a</td>
            <td>{battery_current()?.time && new Date(battery_current()!.time).toLocaleString()}</td>
          </tr>
          <tr>
            <td>Current solar power</td>
            <td>
              {solarInput() + ""}w ({solar_input_power_1()?.value}w + {solar_input_power_2()?.value}w)
            </td>
            <td>{solar_input_power_1()?.time && new Date(solar_input_power_1()!.time).toLocaleString()}</td>
          </tr>
          <tr>
            <td>AC output power</td>
            <td>
              {ac_output() + ""}w (R: {ac_output_active_power_r()?.value}w, S: {ac_output_active_power_s()?.value}w, T:{" "}
              {ac_output_active_power_t()?.value}w)
            </td>
            <td>
              {ac_output_total_active_power()?.time && new Date(ac_output_total_active_power()!.time).toLocaleString()}
            </td>
          </tr>
          <tr>
            <td>AC input power</td>
            <td>
              {ac_input() + ""}w (R: {ac_input_active_power_r()?.value as number}w, S:{" "}
              {ac_input_active_power_s()?.value as number}w, T: {ac_input_active_power_t()?.value as number}w)
            </td>
            <td>
              {ac_input_total_active_power()?.time && new Date(ac_input_total_active_power()!.time).toLocaleString()}
            </td>
          </tr>
          <tr>
            <td>AC input amperage</td>
            <td>
              R:{" "}
              {Math.round(
                ((ac_input_active_power_r()?.value as number) / ((ac_input_voltage_r()?.value as number) / 10)) * 10
              ) / 10}
              A, S:{" "}
              {Math.round(
                ((ac_input_active_power_s()?.value as number) / ((ac_input_voltage_s()?.value as number) / 10)) * 10
              ) / 10}
              A, T:{" "}
              {Math.round(
                ((ac_input_active_power_t()?.value as number) / ((ac_input_voltage_t()?.value as number) / 10)) * 10
              ) / 10}
              A
            </td>
            <td>{ac_input_active_power_r()?.time && new Date(ac_input_active_power_r()!.time).toLocaleString()}</td>
          </tr>
          <tr>
            <td>Sum</td>
            <td>{sum() + ""} w</td>
            <td>-</td>
          </tr>
        </tbody>
      </table>
    </main>
  );
}
