import type { Config } from "../../../backend/src/config/config.types";

export type ScheduleWindow = { startMs: number; endMs: number; watts: number; kind: "sell" | "buy" };

/**
 * The config schedules (planner-written and user-written alike) as sorted windows — the source of
 * truth for what the controller will actually do, unlike last_plan which is only the planner's own
 * windows. Entries with unparseable dates are skipped for display (the backend keeps them).
 */
export function scheduleWindowsFromConfig(config: Config | undefined, keepEndsAfterMs: number): ScheduleWindow[] {
  if (!config) return [];
  const windows: ScheduleWindow[] = [];
  for (const [startIso, entry] of Object.entries(config.scheduled_power_selling?.schedule ?? {})) {
    const startMs = +new Date(startIso);
    const endMs = +new Date(entry.end_time);
    if (isFinite(startMs) && isFinite(endMs) && endMs > keepEndsAfterMs) {
      windows.push({ startMs, endMs, watts: Number(entry.power_watts) || 0, kind: "sell" });
    }
  }
  for (const [startIso, entry] of Object.entries(config.scheduled_power_buying?.schedule ?? {})) {
    const startMs = +new Date(startIso);
    const endMs = +new Date(entry.end_time);
    if (isFinite(startMs) && isFinite(endMs) && endMs > keepEndsAfterMs) {
      windows.push({ startMs, endMs, watts: Number(entry.charging_power) || 0, kind: "buy" });
    }
  }
  return windows.sort((a, b) => a.startMs - b.startMs);
}
