import { createMemo, createSignal, For, JSX, onCleanup, untrack } from "solid-js";
import { catchify } from "@depict-ai/utilishared";
import { isServer } from "solid-js/web";
import { Title } from "@solidjs/meta";
import { getBackendSyncedSignal } from "~/helpers/getBackendSyncedSignal";

export default function Temperatures() {
  const [get_temperatures] = getBackendSyncedSignal<
    {
      [key: string]: {
        value: number;
        time: number;
        thermometer_device_id: string;
        label: string;
      };
    },
    true
  >("temperatures", {
    loading: {
      value: 0,
      time: 0,
      thermometer_device_id: "",
      label: "Loading",
    },
    loading2: {
      value: 0,
      time: 0,
      thermometer_device_id: "",
      label: "Loading",
    },
    loading3: {
      value: 0,
      time: 0,
      thermometer_device_id: "",
      label: "Loading",
    },
  });
  const temperature_keys = createMemo(() => Object.keys(get_temperatures()));
  const [get_current_time, set_current_time] = createSignal<JSX.Element>();
  const [get_show_current_time_fractional, set_show_current_time_fractional] = createSignal(false);
  let got_cleanuped = false;

  const update_current_time = () => {
    set_current_time(
      new Date().toLocaleTimeString(undefined, {
        fractionalSecondDigits: untrack(get_show_current_time_fractional) ? 3 : undefined,
        hour: "numeric",
        minute: "numeric",
        second: "numeric",
      })
    );
    if (!got_cleanuped) {
      requestAnimationFrame(update_current_time);
    }
  };

  if (!isServer) {
    update_current_time();
  }

  onCleanup(() => (got_cleanuped = true));

  return (
    <main>
      <Title>Temperatures</Title>
      <h1>Temperatures</h1>
      <h4 onClick={catchify(() => set_show_current_time_fractional(old => !old))}>
        Current time: {get_current_time()}
      </h4>
      <div class="temperatures">
        <For each={temperature_keys()}>
          {key => {
            const obj = createMemo(() => get_temperatures()[key]);
            const value = createMemo(() => obj().value);
            const time = createMemo(() =>
              new Date(obj().time).toLocaleTimeString(undefined, {
                fractionalSecondDigits: 3,
                hour: "numeric",
                minute: "numeric",
                second: "numeric",
              })
            );
            const label = createMemo(() => obj().label);
            const device_id = createMemo(() => "Device id: " + obj().thermometer_device_id);
            return (
              <div class="temperature" title={device_id()}>
                <h3 class="label">{label()}</h3>
                <h4 class="value">Temperature: {value()}°C</h4>
                <span class="time">Last updated at: {time()}</span>
              </div>
            );
          }}
        </For>
      </div>
    </main>
  );
}
