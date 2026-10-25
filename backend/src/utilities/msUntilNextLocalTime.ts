import { errorLog } from "./logging.ts";

/**
 * Next occurrence of HH:MM in Europe/Stockholm, DST-proof (scans minute marks). One shared
 * formatter: building one per step (toLocaleTimeString) cost 55–190 ms per call on the VM and
 * several times that on the pi — on the event loop the serial engine shares.
 */
export function msUntilNextLocalTime(hhmm: string, nowMs: number = Date.now()): number {
  const startMinute = Math.floor(nowMs / 60000) * 60000;
  for (let minute = 1; minute <= 25 * 60; minute++) {
    const candidate = startMinute + minute * 60000;
    if (STOCKHOLM_HOURS_MINUTES.format(candidate) === hhmm) return candidate - nowMs;
  }
  errorLog("Could not resolve local time", hhmm, "- defaulting to 24h");
  return 24 * 3600 * 1000;
}

/** Same options as toLocaleTimeString("sv-SE", …) used before, so the "HH:MM" strings are identical */
const STOCKHOLM_HOURS_MINUTES = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Europe/Stockholm",
  hour: "2-digit",
  minute: "2-digit",
});
