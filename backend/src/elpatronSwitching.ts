import { Accessor, createEffect, createMemo, createResource } from "solid-js";
import { WebSocket } from "ws";
import { DepictAPIWS, random_string, wait } from "@depict-ai/utilishared/latest";
import { useTotalSolarPower } from "./utilities/useTotalSolarPower";
import { useFromMqttProvider } from "./mqttValues/MQTTValuesProvider";
import { reactiveBatteryVoltage } from "./mqttValues/mqttHelpers";
import { Config } from "./config.types";

// @ts-ignore
globalThis.WebSocket = WebSocket;

let socket: DepictAPIWS | undefined;
let lastSwitch = 0;

export function elpatronSwitching(config: Accessor<Config>) {
  const { mqttValues } = useFromMqttProvider();
  const functionalityEnabled = createMemo(() => config().elpatron_switching.enabled);
  const fromSolar = createMemo(() => useTotalSolarPower());
  const getPowerDirection = () => mqttValues.line_power_direction?.value;

  createEffect(() => {
    if (!functionalityEnabled()) return;
    socket ||= new DepictAPIWS("ws://192.168.1.100:9321");
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
        const maxSwitchEvery = 1000 * 60 * 5;
        if (timeSinceLastSwitch < maxSwitchEvery) {
          const toWait = maxSwitchEvery - timeSinceLastSwitch;
          await wait(toWait);
        }
        const enable = elpatronShouldBeEnabled();
        if (enable == undefined) return;
        const [result] = (await socket?.ensure_sent({
          id: random_string(),
          command: "write-gpio",
          value: { "output": "electric_heating_element", "new_state": enable ? 0 : 1 },
        })) as any;
        lastSwitch = +new Date();

        // log(
        //   (enable ? "Enable" : "Disable") + " elpatron result:",
        //   result,
        //   "for solar",
        //   fromSolar(),
        //   "w, ",
        //   "power direction",
        //   getPowerDirection()
        // );
      }
    );
  });
}
