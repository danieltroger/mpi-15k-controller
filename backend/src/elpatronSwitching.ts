import { type Accessor, createEffect, createMemo, createResource, createSignal, onCleanup, untrack } from "solid-js";
import { random_string, wait } from "./vendor/depictUtilishared.ts";
import { useTotalSolarPower } from "./utilities/useTotalSolarPower.ts";
import { useFromMqttProvider } from "./mqttValues/MQTTValuesProvider.ts";
import { reactiveBatteryVoltage } from "./mqttValues/mqttHelpers.ts";
import {
  getHeatingPiSocket,
  primeElpatronGpioCache,
  primeHeatingGpioFromBroadcast,
  readElpatronGpioIsOn,
} from "./utilities/heatingPi.ts";
import { logLog, warnLog } from "./utilities/logging.ts";
import { type ElpatronDisplayState, type ElpatronMode, resolveElpatronMode } from "./sharedTypes.ts";
import type { DepictAPIWS } from "./vendor/depictUtilishared.ts";
import type { Config } from "./config/config.types.ts";

/** Contactor protection: nothing flips the element more often than this. */
const MAX_SWITCH_EVERY_MS = 1000 * 60 * 5;

let lastSwitch = 0;

export function elpatronSwitching(config: Accessor<Config>) {
  const { mqttValues } = useFromMqttProvider();
  const mode = createMemo(() => resolveElpatronMode(config().elpatron_switching));
  // Memo so effects don't rebuild (and re-send gpio writes) on unrelated config writes
  const heatingPiIp = createMemo(() => config().elpatron_switching.heating_pi_ip);
  const fromSolar = createMemo(() => useTotalSolarPower());
  const getPowerDirection = () => mqttValues.line_power_direction?.value;
  // What the frontend's water-heater card shows; primed by our own writes, kept current by the
  // heating pi's own change broadcasts
  const [elpatronHeating, setElpatronHeatingRaw] = createSignal<ElpatronDisplayState>({
    heating: undefined,
    time: Date.now(),
  });
  // `time` marks the last state CHANGE (the card renders it as "since HH:MM"), so confirmations
  // of an unchanged state keep the old timestamp
  const setElpatronHeating = (elementIsOn: boolean | undefined) =>
    setElpatronHeatingRaw(previous =>
      previous.heating === elementIsOn ? previous : { heating: elementIsOn, time: Date.now() }
    );

  const writeElement = async (socket: DepictAPIWS, turnOn: boolean, why: string) => {
    const [result] = (await socket.ensure_sent({
      id: random_string(),
      command: "write-gpio",
      // The element pin is active-low: raw 0 = powered
      value: { "output": "electric_heating_element", "new_state": turnOn ? 0 : 1 },
    })) as [{ status?: string } | undefined, unknown];
    lastSwitch = Date.now();
    if (result?.status && result.status !== "ok") {
      warnLog("Elpatron: gpio write failed", result, "— wanted", turnOn ? "on" : "off", "because:", why);
      return;
    }
    logLog(`Elpatron: element ${turnOn ? "on" : "off"} (${why})`);
    primeElpatronGpioCache(heatingPiIp(), turnOn);
    setElpatronHeating(turnOn);
  };

  // "Always on" is a standing instruction: when something else (a hand on the heating pi's own
  // controls) switches the element off, re-assert it — contactor-guarded so two automations can
  // never fast-cycle the relay against each other.
  let alwaysOnReassertInFlight = false;
  const enforceAlwaysOnAfterExternalOff = (elementIsOn: boolean) => {
    if (elementIsOn || untrack(mode) !== "always_on" || alwaysOnReassertInFlight) return;
    alwaysOnReassertInFlight = true;
    void (async () => {
      const sinceLastSwitch = Date.now() - lastSwitch;
      if (sinceLastSwitch < MAX_SWITCH_EVERY_MS) await wait(MAX_SWITCH_EVERY_MS - sinceLastSwitch);
      if (untrack(mode) !== "always_on") return; // mode changed while we waited
      await writeElement(getHeatingPiSocket(untrack(heatingPiIp)), true, "always-on re-assert after external off");
    })()
      .catch(e => warnLog("Elpatron: always-on re-assert failed", e))
      .finally(() => (alwaysOnReassertInFlight = false));
  };

  // Live element state: the heating pi's wsMessaging broadcasts {type:"change", key:"gpio"} on
  // every flip, so subscribe instead of polling. Broadcasts don't replay, hence one read now and
  // on every (re)connect — DepictAPIWS re-dispatches "open" across reconnects.
  createEffect(() => {
    const ip = heatingPiIp();
    if (!ip) return;
    const socket = getHeatingPiSocket(ip);
    // No cache prime here: the readNow path just did a real (cache-refreshing) read, and the
    // broadcast path primes the full outputs snapshot itself in onMessage
    const applyState = (elementIsOn: boolean | undefined) => {
      setElpatronHeating(elementIsOn);
      if (elementIsOn !== undefined) enforceAlwaysOnAfterExternalOff(elementIsOn);
    };
    const readNow = () =>
      void readElpatronGpioIsOn(ip, 0)
        .then(applyState)
        .catch(e => warnLog("Elpatron: gpio state read failed", e));
    const onMessage = (event: Event) => {
      try {
        const decoded = JSON.parse(String((event as MessageEvent).data));
        if (decoded?.type !== "change" || decoded.key !== "gpio") return;
        const outputs = decoded.value?.outputs;
        if (outputs?.electric_heating_element === undefined) return;
        // The broadcast carries every output's fresh state — including the stove, which the
        // consumption model's subtraction gate reads
        primeHeatingGpioFromBroadcast(ip, outputs);
        applyState(outputs.electric_heating_element === 0); // active-low
      } catch (e) {
        warnLog("Elpatron: couldn't parse heating pi broadcast", e);
      }
    };
    // A dead link means we can't know the state — show "unknown" instead of freezing the last
    // value (reconnect + readNow restores it)
    const onClose = () => setElpatronHeating(undefined);
    socket.addEventListener("message", onMessage);
    socket.addEventListener("open", readNow);
    socket.addEventListener("close", onClose);
    readNow();
    onCleanup(() => {
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("open", readNow);
      socket.removeEventListener("close", onClose);
    });
  });

  // undefined = process just started. Booting into "off" must NOT write the gpio — in pellet
  // season the heating system owns the element and we have no business touching it on startup.
  // Booting into "always_on" DOES re-assert: that mode exists to be durable.
  let previousMode: ElpatronMode | undefined;
  createEffect(() => {
    const currentMode = mode();
    const cameFrom = previousMode;
    previousMode = currentMode;

    if (currentMode === "off") {
      // Off means off — write it, don't just stop controlling (the pre-2026-07 behavior left the
      // element in whatever state it last had)
      if (cameFrom !== undefined && cameFrom !== "off") {
        void writeElement(getHeatingPiSocket(heatingPiIp()), false, "switched to off mode").catch(e =>
          warnLog("Elpatron: failed to switch off", e)
        );
      }
      return;
    }

    if (currentMode === "always_on") {
      if (cameFrom !== "always_on") {
        void writeElement(
          getHeatingPiSocket(heatingPiIp()),
          true,
          cameFrom === undefined ? "always-on mode (startup re-assert)" : "switched to always-on mode"
        ).catch(e => warnLog("Elpatron: failed to switch on", e));
      }
      return;
    }

    // Solar-gated mode
    const socket = getHeatingPiSocket(heatingPiIp());
    const elpatronShouldBeEnabled = createMemo<boolean | undefined>(() => {
      const solar = fromSolar();
      const powerDirection = getPowerDirection();
      if (solar == undefined || powerDirection == undefined) return;
      return (
        solar > config().elpatron_switching.min_solar_input &&
        // Output direction apparently flakey?
        (powerDirection === "Output" || powerDirection === "Idle" || (reactiveBatteryVoltage() as number) >= 52.8)
      );
    });

    createResource(
      // pass array because createResource ignores falsey values
      () => [elpatronShouldBeEnabled()] as const,
      async () => {
        // Always get latest value
        const timeSinceLastSwitch = +new Date() - lastSwitch;
        if (timeSinceLastSwitch < MAX_SWITCH_EVERY_MS) {
          await wait(MAX_SWITCH_EVERY_MS - timeSinceLastSwitch);
        }
        const enable = elpatronShouldBeEnabled();
        if (enable == undefined) return;
        await writeElement(socket, enable, `solar ${fromSolar()} W, direction ${getPowerDirection()}`);
      }
    );
  });

  return { elpatronHeating };
}
