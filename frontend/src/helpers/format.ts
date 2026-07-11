import { type Accessor, createSignal, onCleanup } from "solid-js";
import { isServer } from "solid-js/web";

/**
 * Shared number/time formatting so every page shows "6.9 kW" and "2 min ago" instead of raw
 * `6912.3` and ISO timestamps. All render-side formatting goes through here — one place to keep
 * units, rounding and locale consistent.
 */

/** Render `value` with `format`, or an em-dash while it hasn't arrived — never `NaN W`, `undefined` or "Invalid Date". */
export function dashUnless<T>(value: T | undefined | null, format: (definedValue: T) => string): string {
  if (value === undefined || value === null) return "—";
  if (typeof value === "number" && !isFinite(value)) return "—";
  return format(value);
}

export function formatWatts(watts: number): string {
  if (Math.abs(watts) < 1000) return `${Math.round(watts)} W`;
  return `${(watts / 1000).toFixed(1)} kW`;
}

export function formatWhAsKwh(wattHours: number): string {
  if (Math.abs(wattHours) < 1000) return `${Math.round(wattHours)} Wh`;
  return `${(wattHours / 1000).toFixed(1)} kWh`;
}

export function formatKwh(kilowattHours: number): string {
  return `${kilowattHours.toFixed(1)} kWh`;
}

export function formatSek(sek: number, options?: { signed?: boolean }): string {
  const magnitude = Math.abs(sek) >= 10 ? String(Math.round(sek)) : sek.toFixed(1).replace(/\.0$/, "");
  const sign = options?.signed && sek > 0 ? "+" : "";
  return `${sign}${magnitude} SEK`;
}

/** Spot prices travel as SEK/kWh but read best in öre. */
export function formatSpotOre(sekPerKwh: number): string {
  return `${Math.round(sekPerKwh * 100)} öre`;
}

export function formatRelativeTime(nowMs: number, thenMs: number): string {
  const seconds = Math.round((nowMs - thenMs) / 1000);
  if (seconds < -1) return `in ${formatDurationMs(-seconds * 1000)}`;
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds} s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 24 * 3600) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / (24 * 3600))} d ago`;
}

/** "2 h 15 min", "45 min", "3 d 4 h" — the two largest units only. */
export function formatDurationMs(ms: number): string {
  const totalMinutes = Math.round(ms / 60_000);
  if (totalMinutes < 1) return "under a minute";
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return hours > 0 ? `${days} d ${hours} h` : `${days} d`;
  if (hours > 0) return minutes > 0 ? `${hours} h ${minutes} min` : `${hours} h`;
  return `${minutes} min`;
}

export function formatClockTime(msOrIso: number | string | Date): string {
  return new Date(msOrIso).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
}

/** "11 juli 16:25" — matches the sv-SE style the trading panel always used. */
export function formatShortDateTime(msOrIso: number | string | Date): string {
  return new Date(msOrIso).toLocaleString("sv-SE", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "Today" / "Tomorrow" / "lör 12 juli" for schedule windows. */
export function formatDayWord(targetMs: number, nowMs: number): string {
  const dayString = (ms: number) => new Date(ms).toLocaleDateString("sv-SE", { timeZone: "Europe/Stockholm" });
  const target = dayString(targetMs);
  if (target === dayString(nowMs)) return "Today";
  if (target === dayString(nowMs + 24 * 3600 * 1000)) return "Tomorrow";
  return new Date(targetMs).toLocaleDateString("sv-SE", { weekday: "short", day: "numeric", month: "short" });
}

/**
 * A ticking "now" for relative-time displays. On the server it stays static (relative times render
 * only after hydration since all live values arrive over the ws anyway).
 */
export function useNowMs(updateEveryMs = 1000): Accessor<number> {
  const [now, setNow] = createSignal(Date.now());
  if (!isServer) {
    const timer = setInterval(() => setNow(Date.now()), updateEveryMs);
    onCleanup(() => clearInterval(timer));
  }
  return now;
}
