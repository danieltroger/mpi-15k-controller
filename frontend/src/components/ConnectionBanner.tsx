import { createMemo, Show } from "solid-js";
import { useConnection } from "~/components/WebSocketProvider";
import { useNowMs } from "~/helpers/format";

/** After this long without any broadcast the on-screen values are suspicious enough to warn about. */
const STALE_BANNER_AFTER_MS = 30_000;

/**
 * Full-width warning strip under the nav. For software that live-controls the house, frozen values
 * that look live are worse than an ugly banner — this makes "not live" unmissable.
 */
export function ConnectionBanner() {
  const { status, lastMessageAt } = useConnection();
  const now = useNowMs(1000);

  const banner = createMemo(() => {
    if (status() === "reconnecting") {
      return { text: "Connection to the controller lost — reconnecting…", stale: false };
    }
    const messageAt = lastMessageAt();
    if (status() === "live" && messageAt !== undefined && now() - messageAt > STALE_BANNER_AFTER_MS) {
      return {
        text: `No data from the controller for ${Math.round((now() - messageAt) / 1000)} s — values may be stale`,
        stale: true,
      };
    }
    return undefined;
  });

  return (
    <Show when={banner()}>
      {activeBanner => (
        <div class={`conn-banner ${activeBanner().stale ? "conn-banner--stale" : ""}`} role="alert">
          {activeBanner().text}
        </div>
      )}
    </Show>
  );
}
