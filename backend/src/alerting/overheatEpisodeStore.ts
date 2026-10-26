import { readFileSync, promises as fs_promises } from "fs";
import { fileURLToPath } from "url";
import { warnLog } from "../utilities/logging.ts";

/**
 * The overheat alerts' episode memory across restarts, in backend/overheat_alert_state.json
 * (gitignored), written on every stop/resume edge. It used to be rebuilt from alertManager's
 * recentAlerts, but that list holds 50 entries and records every rate_capped repeat, so a chatty
 * errorLog evicted the overheat records within a minute and a restart lost the repeat P1 the resume
 * notice had promised (review of #60). Missing or unreadable means a fresh memory: the plain key.
 */
export function loadOverheatEpisode(): PersistedOverheatEpisode | undefined {
  let fileText: string;
  try {
    // Synchronous like alertManager's state: the alert effect's seed must exist before its first run
    fileText = readFileSync(statePath, { encoding: "utf-8" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      warnLog("Overheat alerts: couldn't read the episode file, starting a fresh episode memory", error);
    }
    return undefined;
  }
  lastSavedJson = fileText;
  try {
    const parsed: unknown = JSON.parse(fileText);
    if (isPersistedOverheatEpisode(parsed)) return parsed;
    warnLog("Overheat alerts: ignoring a malformed episode file", fileText.slice(0, 300));
  } catch (error) {
    warnLog("Overheat alerts: ignoring an unparseable episode file", error);
  }
  return undefined;
}

/**
 * Atomic (temp file + rename), so a torn write can't cost the next boot its memory. Writes are
 * chained: two edges can't race on the temp file. Edges are minutes apart, so this is a handful of
 * writes per overheat.
 */
export function saveOverheatEpisode(episode: PersistedOverheatEpisode) {
  const json = JSON.stringify(episode, null, 2);
  if (json === lastSavedJson) return;
  lastSavedJson = json;
  const targetPath = statePath;
  pendingWrite = pendingWrite
    .then(async () => {
      await fs_promises.writeFile(`${targetPath}.tmp`, json, { encoding: "utf-8" });
      await fs_promises.rename(`${targetPath}.tmp`, targetPath);
    })
    .catch(error => warnLog("Overheat alerts: failed to persist the episode memory", targetPath, error));
}

/** Resolves once every queued save has landed (or failed loudly) */
export function flushOverheatEpisodeWrites(): Promise<void> {
  return pendingWrite;
}

/** For selftests only: point the store at a scratch file */
export function useOverheatEpisodeStatePathForTests(path: string) {
  statePath = path;
  lastSavedJson = undefined;
}

/** snake_case like the other machine-owned state files */
export type PersistedOverheatEpisode = {
  /** The newest edge was a resume: the next stop is a repeat and gets its own onset key */
  last_edge_was_resume: boolean;
  /** The current (or last) stop episode's alert key */
  episode_key: string;
};

let statePath = fileURLToPath(new URL("../../overheat_alert_state.json", import.meta.url));
let lastSavedJson: string | undefined;
let pendingWrite: Promise<void> = Promise.resolve();

function isPersistedOverheatEpisode(value: unknown): value is PersistedOverheatEpisode {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.last_edge_was_resume === "boolean" && typeof candidate.episode_key === "string";
}
