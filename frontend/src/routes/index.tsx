import { getBackendSyncedSignal } from "~/helpers/getBackendSyncedSignal";
import { Accessor, createEffect, createMemo, createSignal, getOwner, onMount, Show } from "solid-js";
import { A } from "@solidjs/router";
import { CurrentBatteryPowerBroadcast, MqttValue } from "../../../backend/src/sharedTypes";
import { showToastWithMessage } from "~/helpers/showToastWithMessage";
import { Config } from "../../../backend/src/config.types";

export default function Home() {
  const [totalLastEmpty] = getBackendSyncedSignal<number>("totalLastEmpty");
  const [energyRemovedSinceFull] = getBackendSyncedSignal<number>("energyRemovedSinceFull");
  const [energyAddedSinceEmpty] = getBackendSyncedSignal<number>("energyAddedSinceEmpty");
  const [isCharging] = getBackendSyncedSignal<number>("isCharging");
  const [totalLastFull] = getBackendSyncedSignal<string>("totalLastFull");
  const [line_power_direction] = getBackendSyncedSignal<MqttValue>("line_power_direction");
  const [hasHydrated, setHasHydrated] = createSignal(false);
  const [socSinceEmpty] = getBackendSyncedSignal<number>("socSinceEmpty");
  const [socSinceFull] = getBackendSyncedSignal<number>("socSinceFull");
  const [voltageSagMillivoltsRaw] = getBackendSyncedSignal<{ value: number; time: number }>("voltageSagMillivoltsRaw");
  const [voltageSagMillivoltsAveraged] = getBackendSyncedSignal<number>("voltageSagMillivoltsAveraged");
  const [assumedCapacity] = getBackendSyncedSignal<number>("assumedCapacity");
  const [assumedParasiticConsumption] = getBackendSyncedSignal<number>("assumedParasiticConsumption");
  const [config] = getBackendSyncedSignal<Config>("config", undefined, false);
  const owner = getOwner()!;

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
            <A href="/live-data">Live data</A>
          </li>
        </ol>
      </section>
      <section>
        <h2>Some info</h2>
        <br />
        line_power_direction: {line_power_direction()?.value}
        <br />
        energyRemovedSinceFull: {energyRemovedSinceFull()}
        <br />
        isCharging: {isCharging() + ""}
        <br />
        Time last full: {new Date(totalLastFull()!).toLocaleString()}
        <br />
        Time last empty: {new Date(totalLastEmpty()!).toLocaleString()}
        <br />
        assumedParasiticConsumption: {assumedParasiticConsumption()}
        <br />
        Added since empty: {energyAddedSinceEmpty()}
        <br />
        <FullOrEmptyIn
          energyRemovedSinceFull={energyRemovedSinceFull}
          assumedParasiticConsumption={assumedParasiticConsumption}
          energyAddedSinceEmpty={energyAddedSinceEmpty}
        />
        <h4>
          Percent SOC assuming {assumedCapacity()}
          wh capacity:
        </h4>
        Since full: {socSinceFull()}%<br />
        Since empty: {socSinceEmpty()}%<br />
        <br />
        <h4>Battery current measuring</h4>
        Raw: {voltageSagMillivoltsRaw()?.value}mv
        <br />
        Calc current:{" "}
        {voltageSagMillivoltsRaw()?.value == undefined || !config()?.current_measuring
          ? "Loading…"
          : (voltageSagMillivoltsRaw()?.value! - (config()?.current_measuring?.zero_current_millivolts as number)) /
              (config()?.current_measuring?.millivolts_per_ampere as number) +
            "A"}
        <br />
        Averaged: {voltageSagMillivoltsAveraged()}mv
        <br />
        Calc current averaged:{" "}
        {voltageSagMillivoltsAveraged() == undefined || !config()?.current_measuring
          ? "Loading…"
          : (voltageSagMillivoltsAveraged()! - (config()?.current_measuring?.zero_current_millivolts as number)) /
              (config()?.current_measuring?.millivolts_per_ampere as number) +
            "A"}
        <br />
      </section>
      <Show when={hasHydrated()}>
        <NoBuyDebug />
      </Show>
    </main>
  );
}

function FullOrEmptyIn({
  energyRemovedSinceFull,
  assumedParasiticConsumption,
  energyAddedSinceEmpty,
}: {
  energyRemovedSinceFull: Accessor<number | undefined>;
  energyAddedSinceEmpty: Accessor<number | undefined>;
  assumedParasiticConsumption: Accessor<number | undefined>;
}) {
  const [currentBatteryPower] = getBackendSyncedSignal<CurrentBatteryPowerBroadcast>("currentBatteryPower");
  const chargingAt = createMemo(() => {
    let chargingAt = currentBatteryPower()?.value;
    if (chargingAt == undefined) return chargingAt;
    return chargingAt - (assumedParasiticConsumption() || 0);
  });
  const isDischarging = createMemo(() => {
    return (chargingAt() as number) < 0;
  });
  const fullIn = createMemo(() => {
    const capacityLeft = energyRemovedSinceFull();
    const chargingWith = chargingAt();
    if (chargingWith == undefined || capacityLeft == undefined || chargingWith < 0) return { timeLeft: "unknown" };
    const hours = capacityLeft / chargingWith;
    const fullAtDate = new Date(+new Date() + hours * 60 * 60 * 1000);
    const timeLeft = formatWithINTL(new Date(), fullAtDate, "en");
    return { timeLeft, fullAtDate };
  });

  const emptyIn = createMemo(() => {
    const capacityLeft = energyAddedSinceEmpty();
    const chargingWith = chargingAt();
    if (chargingWith == undefined || capacityLeft == undefined || chargingWith > 0) return { timeLeft: "unknown" };
    const hours = capacityLeft / chargingWith;
    const emptyAtDate = new Date(+new Date() + hours * 60 * 60 * 1000);
    const timeLeft = formatWithINTL(emptyAtDate, new Date(), "en");
    return { timeLeft, emptyAtDate };
  });

  return (
    <>
      <Show
        when={isDischarging()}
        fallback={
          <span title={fullIn()?.fullAtDate?.toLocaleString()}>At charge rate, battery full {fullIn().timeLeft}</span>
        }
      >
        <span title={emptyIn()?.emptyAtDate?.toLocaleString()}>
          At discharge rate, battery empty {emptyIn().timeLeft}
        </span>
      </Show>
      <br />
    </>
  );
}

const secondsInAMinute = 60;
const secondsInAnHour = secondsInAMinute * 60;
const secondsInADay = secondsInAnHour * 24;

// https://github.com/tc39/proposal-intl-duration-format/issues/174#issuecomment-1807235436
function formatWithINTL(date: Date, now: Date, locale: string): string {
  const intlObject = new Intl.RelativeTimeFormat(locale);
  const listFormatter = new Intl.ListFormat(locale, { style: "long", type: "conjunction" });
  const timeComponents: string[] = [];
  let seconds = Math.round((+now - +date) / 1000);

  const days = Math.floor(seconds / secondsInADay);
  seconds %= secondsInADay; // Remainder after subtracting days

  const hours = Math.floor(seconds / secondsInAnHour);
  seconds %= secondsInAnHour; // Remainder after subtracting hours

  const minutes = Math.floor(seconds / secondsInAMinute);
  seconds %= secondsInAMinute; // Remainder after subtracting minutes

  if (days > 0) timeComponents.push(intlObject.format(days, "day"));
  if (hours > 0) timeComponents.push(intlObject.format(hours, "hour"));
  if (minutes > 0) timeComponents.push(intlObject.format(minutes, "minute"));
  if (seconds > 0 || timeComponents.length === 0) timeComponents.push(intlObject.format(seconds, "second"));

  return listFormatter.format(timeComponents);
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
  const [lastFeedWhenNoSolarReason] = getBackendSyncedSignal<{ what: string; when: number }>(
    "lastFeedWhenNoSolarReason"
  );
  const [lastChangingFeedWhenNoSolarReason] = getBackendSyncedSignal<{ what: string; when: number }>(
    "lastChangingFeedWhenNoSolarReason"
  );
  const availablePower = createMemo(() => solarPower() - acOutputPower());

  return (
    <section>
      <h2>Debug for no power buying</h2>
      <p>
        {availablePower()} watts, which is made out of {solarPower()} watts minus {acOutputPower()} watts
      </p>
      <Show when={lastFeedWhenNoSolarReason()}>
        {new Date(lastFeedWhenNoSolarReason()?.when!).toLocaleString()}: {lastFeedWhenNoSolarReason()?.what}
        <br />
      </Show>
      <Show when={lastChangingFeedWhenNoSolarReason()}>
        {new Date(lastChangingFeedWhenNoSolarReason()?.when!).toLocaleString()}:{" "}
        {lastChangingFeedWhenNoSolarReason()?.what}
      </Show>
    </section>
  );
}
