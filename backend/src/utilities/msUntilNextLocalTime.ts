import { errorLog } from "./logging.ts";

/** Next occurrence of HH:MM in Europe/Stockholm, DST-proof (scans minute marks). */
export function msUntilNextLocalTime(hhmm: string): number {
  const now = Date.now();
  const startMinute = Math.floor(now / 60000) * 60000;
  for (let m = 1; m <= 25 * 60; m++) {
    const candidate = startMinute + m * 60000;
    const local = new Date(candidate).toLocaleTimeString("sv-SE", {
      timeZone: "Europe/Stockholm",
      hour: "2-digit",
      minute: "2-digit",
    });
    if (local === hhmm) return candidate - now;
  }
  errorLog("Could not resolve local time", hhmm, "- defaulting to 24h");
  return 24 * 3600 * 1000;
}
