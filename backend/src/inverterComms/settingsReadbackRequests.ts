/**
 * Settings readbacks a consumer asked for ahead of the poll interval (the session's
 * requestSettingsReadback), pure. A request stays open until its query is decoded: a round a setter cut
 * short, or one where the query went unanswered or was gate-dropped, doesn't close it, so the next round
 * reads the settings again. It lapses after SETTINGS_READBACK_REQUEST_LIFETIME_MS (schedulerTiming.ts).
 */
import type { SettingsQueryCommandName } from "./pi17Protocol.types.ts";

/** When each still-open request was made (monotonic ms) */
export type SettingsReadbackRequests = Readonly<Partial<Record<SettingsQueryCommandName, number>>>;

/** Does an open request make the next poll round a settings round? */
export function settingsReadbackRequested(
  requests: SettingsReadbackRequests,
  nowMs: number,
  lifetimeMs: number
): boolean {
  return Object.values(requests).some(requestedAtMs => nowMs - requestedAtMs < lifetimeMs);
}

export function withReadbackRequested(
  requests: SettingsReadbackRequests,
  query: SettingsQueryCommandName,
  nowMs: number
): SettingsReadbackRequests {
  return { ...requests, [query]: nowMs };
}

/** The query was decoded: its request is answered */
export function withReadbackAnswered(
  requests: SettingsReadbackRequests,
  query: SettingsQueryCommandName
): SettingsReadbackRequests {
  if (requests[query] === undefined) return requests;
  const remaining = { ...requests };
  delete remaining[query];
  return remaining;
}
