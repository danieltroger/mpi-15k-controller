import type { Config } from "../config/config.types.ts";
import type { FixedWindow } from "./planner.types.ts";

/**
 * The config's sell schedule as windows, the user's entries and ours alike, ended ones included.
 * Entries with an unparseable start or end are skipped (like userWindows does); config.json is
 * hand-editable.
 */
export function sellScheduleWindows(schedule: Config["scheduled_power_selling"]["schedule"]): FixedWindow[] {
  const windows: FixedWindow[] = [];
  for (const [startKey, entry] of Object.entries(schedule)) {
    const startMs = +new Date(startKey);
    const endMs = +new Date(entry.end_time);
    if (isFinite(startMs) && isFinite(endMs)) windows.push({ startMs, endMs, watts: Number(entry.power_watts) || 0 });
  }
  return windows;
}
