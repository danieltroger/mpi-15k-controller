import { type Accessor, createEffect, type Owner, runWithOwner, type Signal, untrack } from "solid-js";
import { startWsServer } from "./startWsServer.ts";
import { useTemperatures } from "../temperatureMeasuring/useTemperatures.ts";
import { applyConfigPatch } from "../config/configPatch.ts";
import type { Config } from "../config/config.types.ts";
import type { TemperatureReadingBroadcast } from "../sharedTypes.ts";
import type { ConfigPatchOp, WsAction, WsExposedAccessorMap } from "../wsContract.types.ts";

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
  // Every exposed signal is read-only over the ws; config is written exclusively through the
  // path-scoped patch command below (the whole-object write reverted concurrent backend updates
  // from stale client copies — the 2026-07-16 drain_a incident — and no longer exists).
  const exposed_signals = {
    config: { getter: get_config },
    temperatures: {
      getter: () => serializeTemperatures(temperatures),
    },
    ...Object.fromEntries(Object.entries(exposedAccessors).map(([key, accessor]) => [key, { getter: accessor }])),
  } as const;

  const { broadcast } = await startWsServer(async (msg: { [key: string]: any }) => {
    const { command, key, value, id, action, path, op } = msg;

    if (command === "patch") {
      // Path-scoped config write: applies exactly the named path onto the LIVE config (never a
      // client-supplied base object), so a stale client can only affect the field it touched.
      if (key !== "config") {
        return JSON.stringify({ id, status: "not-ok", message: `Only the config key supports patch, got: ${key}` });
      }
      // applyConfigPatch validates path/op/value and returns an error message naming the path
      let patchError: string | undefined;
      set_config(current => {
        const result = applyConfigPatch(current, { path, op: op as ConfigPatchOp, value });
        if ("error" in result) {
          patchError = result.error;
          return current;
        }
        return result.patched;
      });
      if (patchError) {
        return JSON.stringify({ id, status: "not-ok", message: patchError });
      }
      return JSON.stringify({ id, status: "ok" });
    }

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

    if (command === "write") {
      // Loud tombstone for pre-patch frontends still holding the old protocol in a stale tab
      return JSON.stringify({
        id,
        status: "not-ok",
        message: `The whole-object write command no longer exists — config is written through path-scoped "patch" commands. Reload the page if this tab is old.`,
      });
    }

    if (command === "read") {
      const specifier = exposed_signals[key as keyof typeof exposed_signals];
      if (!specifier) {
        return JSON.stringify({
          id,
          status: "not-ok",
          message: `No signal with key: ${key}, allowed keys: ${Object.keys(exposed_signals).join(", ")}`,
        });
      }
      return JSON.stringify({ id, status: "ok", value: untrack(specifier.getter as Accessor<any>) });
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
