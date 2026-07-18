import { type Accessor, createEffect, createSignal, getOwner, onCleanup } from "solid-js";
import { random_string } from "@depict-ai/utilishared/latest";
import { useVisibilityState } from "@depict-ai/ui/latest";
import { showToastWithMessage } from "~/helpers/showToastWithMessage";
import { useWebSocket } from "~/components/WebSocketProvider";
import { isServer } from "solid-js/web";
import type { WsAction, WsExposedSignals, WsSignalKey } from "../../../backend/src/wsContract.types";

/** Fire a backend action (command: "action") and return its result string, or undefined on failure. */
export async function sendBackendAction(
  socket: ReturnType<typeof useWebSocket>,
  action: WsAction
): Promise<string | undefined> {
  const [response] = (await socket?.ensure_sent({
    id: random_string(),
    command: "action",
    action,
  })) as [{ id: string; status: "ok" | "not-ok"; value?: string; message?: string }, string];
  if (response.status === "ok") return response.value ?? "ok";
  console.error(response);
  throw new Error(response.message || "Action failed");
}

/**
 * A signal mirroring one backend-exposed value, typed by the ws contract (wsContract.types.ts):
 * the key must exist there and the value type is inferred from it — a typo'd key or a wrongly
 * assumed shape fails to compile instead of failing at runtime. Read-only: config, the one
 * writable value, is written through path-scoped patches (useConfigPatcher), never wholesale.
 */
// With a default value the accessor never yields undefined
export function getBackendSyncedSignal<K extends WsSignalKey>(
  key: K,
  default_value: WsExposedSignals[K],
  refetchOnVisibilityChange?: boolean,
  silentReadErrors?: boolean
): readonly [Accessor<WsExposedSignals[K]>];
// Without one, undefined means "hasn't arrived yet"
export function getBackendSyncedSignal<K extends WsSignalKey>(
  key: K,
  default_value?: undefined,
  refetchOnVisibilityChange?: boolean,
  silentReadErrors?: boolean
): readonly [Accessor<WsExposedSignals[K] | undefined>];
export function getBackendSyncedSignal<K extends WsSignalKey>(
  key: K,
  default_value?: WsExposedSignals[K],
  refetchOnVisibilityChange = true,
  /** Log read failures to the console instead of toasting — for keys an older backend may not expose yet. */
  silentReadErrors = false
) {
  type Value = WsExposedSignals[K] | undefined;
  const socket = useWebSocket();
  const owner = getOwner();
  const [get_value, set_actual_signal] = createSignal<Value>(default_value);

  const result = [get_value] as const;

  if (isServer) {
    return result;
  }

  const pageIsVisible = useVisibilityState();
  const message_handler = ({ data }: MessageEvent) => {
    const decoded = JSON.parse(data);
    if (decoded.type === "change" && decoded.key === key) {
      // functional form like the other setters — a bare value would be *called* if it were a function
      set_actual_signal(() => decoded.value);
    }
  };
  const requestValueUpdate = async () => {
    const [response, response_json] = (await socket?.ensure_sent({
      id: random_string(),
      command: "read",
      key,
    })) as [
      {
        id: string;
        status: "ok" | "not-ok";
        value: Value;
      },
      string,
    ];
    if (response.status === "ok") {
      set_actual_signal(() => response.value);
    } else if (silentReadErrors) {
      console.warn(`Backend can't provide ${key} (yet?):`, response_json);
    } else {
      console.error(response);
      if (owner) await showToastWithMessage(owner, () => `Error reading ${key}: ${response_json}`);
    }
  };
  socket?.addEventListener("message", message_handler as EventListener);
  onCleanup(() => socket?.removeEventListener("message", message_handler as EventListener));

  // Initially, and when leaving the tab and coming back, poll for current values
  // Otherwise when opening a tab that has been suspended for a while, we will show ancient values until a new broadcast comes in for that value
  if (refetchOnVisibilityChange) {
    createEffect(() => pageIsVisible() && requestValueUpdate());
  } else {
    requestValueUpdate();
  }

  return result;
}
