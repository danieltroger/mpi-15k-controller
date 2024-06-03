import { Accessor, createEffect, createSignal, getOwner, onCleanup, Signal } from "solid-js";
import { random_string } from "@depict-ai/utilishared/latest";
import { useVisibilityState } from "@depict-ai/ui/latest";
import { showToastWithMessage } from "~/helpers/showToastWithMessage";
import { useWebSocket } from "~/components/WebSocketProvider";
import { isServer } from "solid-js/web";

export function getBackendSyncedSignal<T, default_value_was_provided extends boolean = false>(
  key: string,
  default_value?: T,
  refetchOnVisibilityChange = true
) {
  const socket = useWebSocket();
  const signal = createSignal<T>(default_value!);

  if (isServer) {
    return signal as default_value_was_provided extends true ? Signal<T> : Signal<T | undefined>;
  }

  const [get_value, set_actual_signal] = signal;
  const owner = getOwner()!;
  const pageIsVisible = useVisibilityState();
  const message_handler = ({ data }: MessageEvent) => {
    const decoded = JSON.parse(data);
    if (decoded.type === "change" && decoded.key === key) {
      set_actual_signal(decoded.value);
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
        value: any;
      },
      string,
    ];
    if (response.status === "ok") {
      set_actual_signal(response.value);
    } else {
      console.error(response);
      await showToastWithMessage(owner, () => `Error reading ${key}: ${response_json}`);
    }
  };
  socket?.addEventListener("message", message_handler as any);
  onCleanup(() => socket?.removeEventListener("message", message_handler as any));

  // Initially, and when leaving the tab and coming back, poll for current values
  // Otherwise when opening a tab that has been suspended for a while, we will show ancient values until a new broadcast comes in for that value
  if (refetchOnVisibilityChange) {
    createEffect(() => pageIsVisible() && requestValueUpdate());
  } else {
    requestValueUpdate();
  }

  return [
    get_value as default_value_was_provided extends true ? Accessor<T> : Accessor<T | undefined>,
    async (new_value: T) => {
      set_actual_signal(() => new_value); // set the signal immediately, since that's what's expected of a signal and we kind of want to emulate that
      try {
        const [response] = (await socket?.ensure_sent({
          id: random_string(),
          command: "write",
          key,
          value: new_value,
        })) as [
          {
            id: string;
            status: "ok" | "not-ok";
            value: any;
            message?: string;
          },
          string,
        ];
        if (response.status === "ok") {
          return true;
        }
        console.error(response);
        throw response.message;
      } catch (e) {
        console.error(e);
        await showToastWithMessage(owner, () => `Error writing ${key}: ${e}`);
      }
      return false;
    },
  ] as const;
}
