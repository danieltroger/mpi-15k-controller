import { type Accessor, createEffect, type Owner, runWithOwner, type Signal, untrack } from "solid-js";
import { startWsServer } from "./startWsServer.ts";
import { useTemperatures } from "../temperatureMeasuring/useTemperatures.ts";
import type { Config } from "../config/config.types.ts";
import type { TemperatureReadingBroadcast } from "../sharedTypes.ts";
import type { WsAction, WsExposedAccessorMap } from "../wsContract.types.ts";

export async function wsMessaging({
  config_signal: [get_config, set_config],
  owner,
  temperatures,
  exposedAccessors,
  actions,
}: {
  config_signal: Signal<Config>;
  owner: Owner;
  temperatures: ReturnType<typeof useTemperatures>;
  /** Typed by the ws contract — exposing a key with the wrong shape (or forgetting one) won't compile */
  exposedAccessors: WsExposedAccessorMap;
  actions: Record<WsAction, () => Promise<string>>;
}) {
  const exposed_signals = {
    config: {
      getter: get_config,
      // Clients write the WHOLE config object from their own (possibly stale) copy — a phone tab that
      // re-synced 80 min ago and then saved reverted an Ah-ledger drain update on 2026-07-16. The
      // machine-owned EMA state must therefore always be taken from the live value, never the client's:
      // these fields are only ever written by the ledger's parameter tracking. To seed them manually,
      // stop the service and edit config.json.
      setter: (value: Config) =>
        set_config(current => ({
          ...value,
          soc_calculations: {
            ...value.soc_calculations,
            ah_ledger: {
              ...value.soc_calculations.ah_ledger,
              drain_a: current.soc_calculations.ah_ledger.drain_a,
              capacity_ah: current.soc_calculations.ah_ledger.capacity_ah,
            },
          },
        })),
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
    const { command, key, value, id, action } = msg;

    if (command === "action") {
      // action arrives as untrusted wire input — the runtime unknown-action reply below handles misses
      const handler = (actions as Partial<Record<string, () => Promise<string>>>)[String(action)];
      if (!handler) {
        return JSON.stringify({
          id,
          status: "not-ok",
          message: `Unknown action: ${action}, allowed actions: ${Object.keys(actions).join(", ")}`,
        });
      }
      try {
        return JSON.stringify({ id, status: "ok", value: await handler() });
      } catch (e) {
        return JSON.stringify({ id, status: "not-ok", message: `Action ${action} failed: ${e}` });
      }
    }

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

function serializeTemperatures(
  temperatures: ReturnType<typeof useTemperatures>
): Record<string, TemperatureReadingBroadcast> {
  // Thermometers without a reading yet are omitted (JSON.stringify would drop the undefineds
  // on the wire anyway — filtering makes the contract type honest)
  return Object.fromEntries(
    Object.entries(temperatures())
      .map(([device_id, value]) => [device_id, value()] as const)
      .filter((entry): entry is readonly [string, TemperatureReadingBroadcast] => entry[1] !== undefined)
  );
}
