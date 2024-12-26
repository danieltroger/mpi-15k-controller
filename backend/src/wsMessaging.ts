import { Accessor, createEffect, Owner, runWithOwner, Signal, untrack } from "solid-js";
import { Config } from "./config";
import { startWsServer } from "./startWsServer";
import { useTemperatures } from "./useTemperatures";

export async function wsMessaging({
  config_signal: [get_config, set_config],
  owner,
  temperatures,
  exposedAccessors,
}: {
  config_signal: Signal<Config>;
  owner: Owner;
  temperatures: ReturnType<typeof useTemperatures>;
  exposedAccessors: Record<string, Accessor<any>>;
}) {
  const exposed_signals = {
    config: {
      getter: get_config,
      setter: set_config,
      validator: (value: Config) => {
        if (typeof value !== "object") {
          return "Can't write config, not an object: " + value;
        }
      },
    },
    temperatures: {
      getter: () => serializeTemperatures(temperatures),
    },
    ...Object.fromEntries(Object.entries(exposedAccessors).map(([key, accessor]) => [key, { getter: accessor }])),
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
        return JSON.stringify({ id, status: "ok", value: untrack(getter as Accessor<any>) });
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

function serializeTemperatures(temperatures: ReturnType<typeof useTemperatures>) {
  return Object.fromEntries(Object.entries(temperatures()).map(([device_id, value]) => [device_id, value()]));
}
