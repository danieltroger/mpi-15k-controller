import { getBackendSyncedSignal } from "~/helpers/getBackendSyncedSignal";
import { createEffect, createMemo, createSignal, onMount, Show } from "solid-js";
import { A } from "@solidjs/router";
import { InfoBroadcast } from "../../../backend/src/sharedTypes";

export default function Home() {
  const [info] = getBackendSyncedSignal<InfoBroadcast>("info");
  const [energyDischargedSinceEmpty] = getBackendSyncedSignal<number>("energyDischargedSinceEmpty");
  const [energyChargedSinceEmpty] = getBackendSyncedSignal<number>("energyChargedSinceEmpty");
  const [totalLastEmpty] = getBackendSyncedSignal<number>("totalLastEmpty");
  const [mqttValues] = getBackendSyncedSignal<Record<string, { value: any; time: number }>>("mqttValues");
  const [hasHydrated, setHasHydrated] = createSignal(false);
  const assumedCapacity = 19.2 * 12 * 3 * 16;
  const energyAddedSinceEmpty = createMemo(() => {
    const discharged = energyDischargedSinceEmpty();
    const charged = energyChargedSinceEmpty();
    if (charged == undefined && discharged == undefined) return undefined;
    if (charged == undefined) return Math.abs(discharged!) * -1;
    if (discharged == undefined) return Math.abs(charged);
    return Math.abs(charged) - Math.abs(discharged);
  });
  const socSinceFull = createMemo(() => {
    const removedSinceFull = info()?.energyRemovedSinceFull;
    if (removedSinceFull === undefined) return undefined;
    return 100 - (removedSinceFull / assumedCapacity) * 100;
  });
  const socSinceEmpty = createMemo(() => {
    const addedSinceEmpty = energyAddedSinceEmpty();
    if (addedSinceEmpty === undefined) return undefined;
    return (addedSinceEmpty / assumedCapacity) * 100;
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
        </ol>
      </section>
      <section>
        <h2>Info</h2>
        <pre>
          <code>
            <Show when={hasHydrated() && info()} fallback={"Loading…"}>
              {JSON.stringify(info(), null, 2)}
            </Show>
          </code>
        </pre>
        <br />
        Time last empty: {new Date(totalLastEmpty()!).toLocaleString()}
        <br />
        energyDischargedSinceEmpty: {energyDischargedSinceEmpty()}
        <br />
        energyChargedSinceEmpty: {energyChargedSinceEmpty()}
        <br />
        Added since empty: {energyAddedSinceEmpty()}
        <br />
        <h4>Percent SOC assuming {assumedCapacity.toLocaleString()}wh capacity:</h4>
        Since full: {socSinceFull()}%<br />
        Since empty: {socSinceEmpty()}%
      </section>
      <Show when={hasHydrated()}>
        <NoBuyDebug mqttValues={mqttValues} />
      </Show>
      <section>
        <h2>MQTT Values</h2>
        <pre>
          <code>
            <Show when={hasHydrated() && mqttValues()} fallback={"Loading…"}>
              {JSON.stringify(mqttValues(), null, 2)}
            </Show>
          </code>
        </pre>
      </section>
    </main>
  );
}

function NoBuyDebug({ mqttValues }: { mqttValues: () => undefined | Record<string, { value: any; time: number }> }) {
  const solarPower = () =>
    ((mqttValues()?.["solar_input_power_1"]?.value || 0) as number) +
    ((mqttValues()?.["solar_input_power_2"]?.value || 0) as number);
  const acOutputPower = () =>
    ((mqttValues()?.["ac_output_active_power_r"]?.value || 0) as number) +
    ((mqttValues()?.["ac_output_active_power_s"]?.value || 0) as number) +
    ((mqttValues()?.["ac_output_active_power_t"]?.value || 0) as number);
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
