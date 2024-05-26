import { Config, get_config_object } from "./config";
import { Accessor, createEffect, createMemo, createResource, createSignal } from "solid-js";
import { useMQTTValues } from "./useMQTTValues";
import { WebSocket } from "ws";
import { DepictAPIWS, random_string } from "@depict-ai/utilishared/latest";
import { totalSolarPower } from "./utilities/totalSolarPower";
import { log } from "./utilities/logging";
import { useNow } from "./utilities/useNow";

// @ts-ignore
globalThis.WebSocket = WebSocket;

let socket: DepictAPIWS | undefined;

export function elpatronSwitching(
  config: Accessor<Config>,
  mqttValues: ReturnType<typeof useMQTTValues>["mqttValues"]
) {
  const functionalityEnabled = createMemo(() => config().elpatron_switching.enabled);
  const fromSolar = createMemo(() => totalSolarPower(mqttValues));
  const [switchingBlockedUntil, setSwitchingBlockedUntil] = createSignal(0);
  const now = useNow();

  createEffect(() => {
    if (!functionalityEnabled()) return;
    socket ||= new DepictAPIWS("ws://192.168.1.100:9321");
    const elpatronShouldBeEnabled = createMemo<boolean | undefined>(prev => {
      if (switchingBlockedUntil() > now()) return prev;
      const solar = fromSolar();
      if (solar == undefined) return;
      setSwitchingBlockedUntil(+new Date() + 1000 * 60 * 5); // Only allow switching every 5 minutes
      return solar > config().elpatron_switching.min_solar_input && mqttValues.line_power_direction?.value === "Output";
    });

    createResource(
      // pass array because createResource ignores falsey values
      () => [elpatronShouldBeEnabled()] as const,
      async ([enable]) => {
        if (enable == undefined) return;
        const [result] = (await socket?.ensure_sent({
          id: random_string(),
          command: "write-gpio",
          value: { "output": "electric_heating_element", "new_state": enable ? 0 : 1 },
        })) as any;

        log((enable ? "Enable" : "Disable") + " elpatron result:", result);
      }
    );
  });
}
