import { getBackendSyncedSignal } from "~/helpers/getBackendSyncedSignal";
import { createEffect, createMemo, createSignal, onMount, Show } from "solid-js";
import { A } from "@solidjs/router";
import { MqttValue } from "../../../backend/src/sharedTypes";

export default function Home() {
  const [energyDischargedSinceEmpty] = getBackendSyncedSignal<number>("energyDischargedSinceEmpty");
  const [energyChargedSinceEmpty] = getBackendSyncedSignal<number>("energyChargedSinceEmpty");
  const [totalLastEmpty] = getBackendSyncedSignal<number>("totalLastEmpty");
  const [energyRemovedSinceFull] = getBackendSyncedSignal<number>("energyRemovedSinceFull");
  const [energyDischargedSinceFull] = getBackendSyncedSignal<number>("energyDischargedSinceFull");
  const [energyChargedSinceFull] = getBackendSyncedSignal<number>("energyChargedSinceFull");
  const [isCharging] = getBackendSyncedSignal<number>("isCharging");
  const [totalLastFull] = getBackendSyncedSignal<string>("totalLastFull");
  const [line_power_direction] = getBackendSyncedSignal<MqttValue>("line_power_direction");
  const [hasHydrated, setHasHydrated] = createSignal(false);
  const [assumedCapacity, setAssumedCapacity] = createSignal(19.2 * 12 * 3 * 16);
  const energyAddedSinceEmpty = createMemo(() => {
    const discharged = energyDischargedSinceEmpty();
    const charged = energyChargedSinceEmpty();
    if (charged == undefined && discharged == undefined) return undefined;
    if (charged == undefined) return Math.abs(discharged!) * -1;
    if (discharged == undefined) return Math.abs(charged);
    return Math.abs(charged) - Math.abs(discharged);
  });
  const socSinceFull = createMemo(() => {
    const removedSinceFull = energyRemovedSinceFull();
    if (removedSinceFull === undefined) return undefined;
    return 100 - (removedSinceFull / assumedCapacity()) * 100;
  });
  const socSinceEmpty = createMemo(() => {
    const addedSinceEmpty = energyAddedSinceEmpty();
    if (addedSinceEmpty === undefined) return undefined;
    return (addedSinceEmpty / assumedCapacity()) * 100;
  });

  onMount(() => setHasHydrated(true));

  return (
    <main>
      <section>
        <h2>Links</h2>
        <ol>
          <li>
            <A href="/config">Config editor</A>
          </li>
          <li>
            <A href="/temperatures">Temperatures</A>
          </li>
          <li>
            <A href="/parasitic-playground">Parasitic playground</A>
          </li>
        </ol>
      </section>
      <section>
        <h2>Some info</h2>
        <br />
        line_power_direction: {line_power_direction()?.value}
        <br />
        energyDischargedSinceFull: {energyDischargedSinceFull()}
        <br />
        energyChargedSinceFull: {energyChargedSinceFull()}
        <br />
        energyRemovedSinceFull: {energyRemovedSinceFull()}
        <br />
        isCharging: {isCharging() + ""}
        <br />
        Time last full: {new Date(totalLastFull()!).toLocaleString()}
        <br />
        Time last empty: {new Date(totalLastEmpty()!).toLocaleString()}
        <br />
        energyDischargedSinceEmpty: {energyDischargedSinceEmpty()}
        <br />
        energyChargedSinceEmpty: {energyChargedSinceEmpty()}
        <br />
        Added since empty: {energyAddedSinceEmpty()}
        <br />
        <h4>
          Percent SOC assuming{" "}
          <span
            onKeyDown={e => {
              const { key, currentTarget } = e;
              const { textContent } = currentTarget;
              if (key !== "Enter") return;
              e.preventDefault();
              currentTarget.blur();
              const parsed = parseFloat(textContent!);
              if (parsed) {
                setAssumedCapacity(parsed);
              } else {
                currentTarget.textContent = assumedCapacity() + "";
              }
            }}
            onBlur={({ currentTarget }) => (currentTarget.textContent = assumedCapacity() + "")}
            contentEditable={true}
          >
            {assumedCapacity()}
          </span>
          wh capacity:
        </h4>
        Since full: {socSinceFull()}%<br />
        Since empty: {socSinceEmpty()}%
      </section>
      <Show when={hasHydrated()}>
        <NoBuyDebug />
      </Show>
    </main>
  );
}

function NoBuyDebug() {
  const [solar_input_power_1] = getBackendSyncedSignal<MqttValue>("solar_input_power_1");
  const [solar_input_power_2] = getBackendSyncedSignal<MqttValue>("solar_input_power_2");
  const [ac_output_active_power_r] = getBackendSyncedSignal<MqttValue>("ac_output_active_power_r");
  const [ac_output_active_power_s] = getBackendSyncedSignal<MqttValue>("ac_output_active_power_s");
  const [ac_output_active_power_t] = getBackendSyncedSignal<MqttValue>("ac_output_active_power_t");
  const solarPower = () =>
    ((solar_input_power_1()?.value || 0) as number) + ((solar_input_power_2()?.value || 0) as number);
  const acOutputPower = () =>
    ((ac_output_active_power_r()?.value || 0) as number) +
    ((ac_output_active_power_s()?.value || 0) as number) +
    ((ac_output_active_power_t()?.value || 0) as number);
  const availablePower = createMemo(() => solarPower() - acOutputPower());
  return (
    <section>
      <h2>Debug for no power buying</h2>
      <p>
        {availablePower()} watts, which is made out of {solarPower()} watts minus {acOutputPower()} watts
      </p>
    </section>
  );
}
