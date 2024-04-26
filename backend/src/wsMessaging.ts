import { Accessor, createEffect, Owner, runWithOwner, Signal, untrack } from "solid-js";
import { Config } from "./config";
import { startWsServer } from "./startWsServer";
import { useMQTTValues } from "./useMQTTValues";

export async function wsMessaging({
  config_signal: [get_config, set_config],
  info,
  owner,
  mqttValues,
}: {
  config_signal: Signal<Config>;
  info: Accessor<Record<string, any>>;
  mqttValues: Accessor<ReturnType<typeof useMQTTValues>>;
  owner: Owner;
}) {
  const exposed_signals = {
    config: {
      getter: get_config,
      setter: set_config,
      validator: value => {
        if (typeof value !== "object") {
          return "Can't write config, not an object: " + value;
        }
      },
    },
    info: { getter: info },
    mqttValues: { getter: mqttValues },
  } as const;

  const { broadcast } = await startWsServer(async (msg: { [key: string]: any }) => {
    const { command, key, value, id } = msg;

    if (command === "read" || command === "write") {
      const specifier = exposed_signals[key as keyof typeof exposed_signals];
      if (!specifier) {
        return JSON.stringify({
          id,
          status: "not-ok",
          message: `No signal with key: ${key}, allowed keys: ${Object.keys(exposed_signals).join(", ")}`,
        });
      }
      const { getter } = specifier;
      if (command === "read") {
        return JSON.stringify({ id, status: "ok", value: untrack(getter) });
      } else if (command === "write") {
        if (!("setter" in specifier)) {
          return JSON.stringify({
            id,
            status: "not-ok",
            message: `Can't write to signal with key: ${key}, it is read-only`,
          });
        }
        if ("validator" in specifier) {
          const error = specifier.validator(value);
          if (error) {
            return JSON.stringify({ id, status: "not-ok", message: error });
          }
        }
        specifier.setter(value);
        return JSON.stringify({ id, status: "ok", value });
      }
    }
    return JSON.stringify({
      id,
      status: "not-ok",
      message: "Command not recognized: " + command,
    });
  });

  for (const key in exposed_signals) {
    const { getter } = exposed_signals[key as keyof typeof exposed_signals];
    runWithOwner(owner, () =>
      createEffect(() => broadcast(JSON.stringify({ id: Math.random() + "", type: "change", key, "value": getter() })))
    );
  }
}