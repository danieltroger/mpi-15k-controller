import { type Accessor, createEffect, createMemo, createResource, createSignal, onCleanup } from "solid-js";
import { random_string, wait } from "./vendor/depictUtilishared.ts";
import { useTotalSolarPower } from "./utilities/useTotalSolarPower.ts";
import { useFromMqttProvider } from "./mqttValues/MQTTValuesProvider.ts";
import { reactiveBatteryVoltage } from "./mqttValues/mqttHelpers.ts";
import { getHeatingPiSocket, primeElpatronGpioCache, readElpatronGpioIsOn } from "./utilities/heatingPi.ts";
import { logLog, warnLog } from "./utilities/logging.ts";
import type { DepictAPIWS } from "./vendor/depictUtilishared.ts";
import type { Config } from "./config/config.types.ts";
import type { ElpatronDisplayState } from "./sharedTypes.ts";

/** Contactor protection: the solar logic never flips the element more often than this. */
const MAX_SWITCH_EVERY_MS = 1000 * 60 * 5;

let lastSwitch = 0;

export function elpatronSwitching(config: Accessor<Config>) {
  const { mqttValues } = useFromMqttProvider();
  const functionalityEnabled = createMemo(() => config().elpatron_switching.enabled);
  // Memo so the effect doesn't rebuild (and re-send gpio writes) on unrelated config writes
  const heatingPiIp = createMemo(() => config().elpatron_switching.heating_pi_ip);
  const fromSolar = createMemo(() => useTotalSolarPower());
  const getPowerDirection = () => mqttValues.line_power_direction?.value;
  // What the frontend's water-heater card shows; primed by our own writes, refreshed by the poll
  const [elpatronHeating, setElpatronHeating] = createSignal<ElpatronDisplayState>({
    heating: undefined,
    time: Date.now(),
  });

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
    setElpatronHeating({ heating: turnOn, time: Date.now() });
  };

  // Live state for the frontend card — poll the GPIO once a minute while an ip is configured
  createEffect(() => {
    const ip = heatingPiIp();
    if (!ip) return;
    const poll = () =>
      void readElpatronGpioIsOn(ip, 55_000)
        .then(isOn => setElpatronHeating({ heating: isOn, time: Date.now() }))
        .catch(e => warnLog("Elpatron: state poll failed", e));
    poll();
    const timer = setInterval(poll, 60_000);
    onCleanup(() => clearInterval(timer));
  });

  // undefined = process just started: booting while disabled must NOT write the gpio — in pellet
  // season the heating system owns the element and we have no business touching it.
  let previouslyEnabled: boolean | undefined;
  createEffect(() => {
    if (!functionalityEnabled()) {
      // Turning solar switching off in the UI means "heater off", so write that — the old code
      // only stopped controlling, silently leaving the element in whatever state it last had.
      if (previouslyEnabled) {
        void writeElement(getHeatingPiSocket(heatingPiIp()), false, "solar-based switching turned off").catch(e =>
          warnLog("Elpatron: failed to switch off after disable", e)
        );
      }
      previouslyEnabled = false;
      return;
    }
    previouslyEnabled = true;
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
