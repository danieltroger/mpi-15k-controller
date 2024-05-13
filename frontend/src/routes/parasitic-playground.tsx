import { Title } from "@solidjs/meta";
import { getBackendSyncedSignal } from "~/helpers/getBackendSyncedSignal";
import { CurrentBatteryPowerBroadcast, MqttValue } from "../../../backend/src/sharedTypes";
import "./parasitic-playground.scss";
import { createMemo } from "solid-js";

export default function ParasiticPlayground() {
  const [currentBatteryPower] = getBackendSyncedSignal<CurrentBatteryPowerBroadcast>("currentBatteryPower");
  const [solar_input_power_1] = getBackendSyncedSignal<MqttValue>("solar_input_power_1");
  const [solar_input_power_2] = getBackendSyncedSignal<MqttValue>("solar_input_power_2");
  const [ac_output_total_active_power] = getBackendSyncedSignal<MqttValue>("ac_output_total_active_power");
  const [ac_input_total_active_power] = getBackendSyncedSignal<MqttValue>("ac_input_total_active_power");
  const solarInput = createMemo(() => (solar_input_power_1()?.value || 0) + (solar_input_power_2()?.value || 0));
  const battery = createMemo(() => {
    const value = currentBatteryPower()?.value;
    if (value != undefined) return value * -1;
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
    return solar + batteryPower + acOutput + acInput;
  });

  return (
    <main class="parasitic-playground">
      <Title>Parasitic playground</Title>
      <h1>Parasitic playground</h1>
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
            <td>Current battery power</td>
            <td>{battery() + ""} w</td>
            <td>{currentBatteryPower()?.time && new Date(currentBatteryPower()!.time).toLocaleString()}</td>
          </tr>
          <tr>
            <td>Current solar power</td>
            <td>{solarInput() + ""} w</td>
            <td>{solar_input_power_1()?.time && new Date(solar_input_power_1()!.time).toLocaleString()}</td>
          </tr>
          <tr>
            <td>AC output power</td>
            <td>{ac_output() + ""} w</td>
            <td>
              {ac_output_total_active_power()?.time && new Date(ac_output_total_active_power()!.time).toLocaleString()}
            </td>
          </tr>
          <tr>
            <td>AC input power</td>
            <td>{ac_input() + ""} w</td>
            <td>
              {ac_input_total_active_power()?.time && new Date(ac_input_total_active_power()!.time).toLocaleString()}
            </td>
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
