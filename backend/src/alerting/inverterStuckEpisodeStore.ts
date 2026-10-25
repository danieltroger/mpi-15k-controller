import { readFileSync, promises as fs_promises } from "fs";
import path from "path";
import process from "process";
import { warnLog } from "../utilities/logging.ts";
import type { PersistedInverterStuckEpisode } from "./inverterStuckAlertPolicy.ts";
import { inverterStuckRuleIds } from "./inverterStuckDetection.ts";

/**
 * Keeps an open stuck-inverter episode across controller restarts, a plausible reaction to the
 * P2. Without it, a latch that outlives the restart is re-announced quoting the restart as its
 * onset, and a fix made during the downtime never gets its "Resolved".
 */
export function loadOpenEpisode(): PersistedInverterStuckEpisode | undefined {
  let fileText: string;
  try {
    // Synchronous like alertManager's state: the first evaluation tick must already see it
    fileText = readFileSync(episodeFilePath(), { encoding: "utf-8" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      warnLog("Inverter stuck: couldn't read the open-episode file, starting without one", error);
    }
    return undefined;
  }
  lastSavedJson = fileText;
  try {
    const parsed: unknown = JSON.parse(fileText);
    const episode = (parsed as { open_episode?: unknown } | null)?.open_episode;
    if (episode === null || episode === undefined) return undefined;
    if (isPersistedEpisode(episode)) return episode;
    warnLog("Inverter stuck: ignoring a malformed open-episode file", fileText.slice(0, 300));
  } catch (error) {
    warnLog("Inverter stuck: ignoring an unparseable open-episode file", error);
  }
  return undefined;
}

/** Writes only when the open episode changed, i.e. on raise / escalate / resolve / signature changes. */
export function saveOpenEpisode(episode: PersistedInverterStuckEpisode | undefined) {
  const json = JSON.stringify({ open_episode: episode ?? null }, null, 2);
  if (json === lastSavedJson) return;
  lastSavedJson = json;
  fs_promises
    .writeFile(episodeFilePath(), json, { encoding: "utf-8" })
    .catch(error => warnLog("Inverter stuck: failed to persist the open episode", error));
}

let lastSavedJson: string | undefined;

function isPersistedEpisode(value: unknown): value is PersistedInverterStuckEpisode {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const onsets = candidate.active_rule_onsets;
  return (
    typeof candidate.raised_at_ms === "number" &&
    (candidate.onset_ms === undefined || typeof candidate.onset_ms === "number") &&
    typeof candidate.escalated === "boolean" &&
    typeof onsets === "object" &&
    onsets !== null &&
    Object.entries(onsets).every(
      ([ruleId, onsetMs]) => (inverterStuckRuleIds as readonly string[]).includes(ruleId) && typeof onsetMs === "number"
    )
  );
}

function episodeFilePath() {
  return path.dirname(process.argv[1]) + "/../inverter_stuck_state.json";
}
