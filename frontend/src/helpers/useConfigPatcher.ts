import { getOwner } from "solid-js";
import { random_string } from "@depict-ai/utilishared/latest";
import { showToastWithMessage } from "~/helpers/showToastWithMessage";
import { useWebSocket } from "~/components/WebSocketProvider";
import type { ConfigPatch, ConfigPatchRequest, ConfigPatchResponse } from "../../../backend/src/wsContract.types";

/**
 * Sends path-scoped config patches over the ws — the only way the frontend writes config. Each
 * patch names exactly the key-path it changes, so a stale tab can never revert anything else.
 * Patches go out sequentially in the order given; callers that mix sets and unsets should send
 * the sets first so a failure mid-batch can leave a duplicate but never a hole. Stops at the
 * first failure (toasting the backend's message, which names the offending path).
 */
export function useConfigPatcher() {
  const socket = useWebSocket();
  const owner = getOwner();

  const sendPatches = async (patches: readonly ConfigPatch[]): Promise<boolean> => {
    for (const patch of patches) {
      try {
        const request: ConfigPatchRequest = { id: random_string(), command: "patch", key: "config", ...patch };
        const [response] = (await socket?.ensure_sent(request)) as [ConfigPatchResponse, string];
        if (response.status !== "ok") throw new Error(response.message || "patch rejected without a message");
      } catch (e) {
        console.error("Config patch failed", patch, e);
        if (owner) {
          await showToastWithMessage(
            owner,
            () => `Saving ${patch.path.join(".")} failed: ${e instanceof Error ? e.message : e}`
          );
        }
        return false;
      }
    }
    return true;
  };

  return { sendPatches, sendPatch: (patch: ConfigPatch) => sendPatches([patch]) };
}
