import { Navigate } from "@solidjs/router";

/** Merged into /system (2026-07) — keep old bookmarks working. */
export default function LiveDataRedirect() {
  return <Navigate href="/system" />;
}
