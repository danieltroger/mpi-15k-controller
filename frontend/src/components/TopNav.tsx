import { A } from "@solidjs/router";
import { createMemo, For } from "solid-js";
import { useConnection } from "~/components/WebSocketProvider";
import { useNowMs } from "~/helpers/format";
import "./TopNav.scss";

const NAV_LINKS = [
  { href: "/", label: "Dashboard" },
  { href: "/buy-sell", label: "Trading" },
  { href: "/live-data", label: "Live data" },
  { href: "/temperatures", label: "Temperatures" },
  { href: "/config", label: "Config" },
  { href: "/diagnostics", label: "Diagnostics" },
];

/** How long without any ws broadcast before "Live" degrades to "Quiet" (backend chatters constantly). */
const QUIET_AFTER_MS = 20_000;

export function TopNav() {
  const { status, lastMessageAt } = useConnection();
  const now = useNowMs(1000);

  const connection = createMemo(() => {
    const currentStatus = status();
    if (currentStatus === "connecting") return { dot: "", label: "Connecting…" };
    if (currentStatus === "reconnecting") return { dot: "dot--crit", label: "Reconnecting…" };
    const messageAt = lastMessageAt();
    if (messageAt !== undefined && now() - messageAt > QUIET_AFTER_MS) {
      return { dot: "dot--warn", label: `Quiet ${Math.round((now() - messageAt) / 1000)} s` };
    }
    return { dot: "dot--ok", label: "Live" };
  });

  return (
    <header class="topbar">
      <div class="topbar__inner">
        <A href="/" class="topbar__brand">
          <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M9 1 3 9.2h3.4L7 15l6-8.2H9.6L9 1Z" fill="var(--battery)" />
          </svg>
          KRAFTVERKET
        </A>
        <nav class="topbar__nav" aria-label="Sections">
          <For each={NAV_LINKS}>
            {link => (
              // `end` stops href="/" from prefix-matching every route; the router's own
              // activeClass ("active") does the highlighting.
              <A href={link.href} end={link.href === "/"}>
                {link.label}
              </A>
            )}
          </For>
        </nav>
        <span class={`topbar__conn ${connection().dot ? "" : "topbar__conn--idle"}`}>
          <span class={`dot ${connection().dot}`} aria-hidden="true"></span>
          {connection().label}
        </span>
      </div>
    </header>
  );
}
