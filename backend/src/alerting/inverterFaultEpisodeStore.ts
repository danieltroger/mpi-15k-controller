import { readFileSync, promises as fs_promises } from "fs";
import { fileURLToPath } from "url";
import { warnLog } from "../utilities/logging.ts";
import type { PersistedInverterFaultAlerts, PersistedModeEpisode } from "./inverterFaultAlertPolicy.ts";

/**
 * Keeps the inverter fault alerts' open episodes (and the last fault code seen) across controller
 * restarts, in backend/inverter_fault_state.json (gitignored), like inverterStuckEpisodeStore.ts
 * does for #51. Without it every restart during a latch — a main() crash loop included — started
 * a fresh episode with a fresh key, so the persisted 30-min cooldown never matched and each
 * restart paged another P1; the P3 was lost too.
 */
export function loadFaultAlertState(): PersistedInverterFaultAlerts | undefined {
  let fileText: string;
  try {
    // Synchronous like alertManager's state: the first evaluation tick must already see it
    fileText = readFileSync(statePath, { encoding: "utf-8" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      warnLog("Inverter fault: couldn't read the alert-state file, starting without it", error);
    }
    return undefined;
  }
  lastSavedJson = fileText;
  try {
    const parsed: unknown = JSON.parse(fileText);
    if (isPersistedFaultAlerts(parsed)) return parsed;
    warnLog("Inverter fault: ignoring a malformed alert-state file", fileText.slice(0, 300));
  } catch (error) {
    warnLog("Inverter fault: ignoring an unparseable alert-state file", error);
  }
  return undefined;
}

/**
 * Writes whenever the persisted state changed: an episode opening, alerting or ending, a new fault
 * code — and, while an episode is open, every MOD reading (its last_reading_at_ms), so about once a
 * minute. Atomic (temp file + rename) like overheatEpisodeStore.ts, so a restart or power cut in
 * the middle of a write can't leave a torn file that costs the next boot its episode; chained, so
 * two writes can't race on the temp file.
 */
export function saveFaultAlertState(persisted: PersistedInverterFaultAlerts): void {
  const json = JSON.stringify(persisted, null, 2);
  if (json === lastSavedJson) return;
  lastSavedJson = json;
  const targetPath = statePath;
  pendingWrite = pendingWrite
    .then(async () => {
      await fs_promises.writeFile(`${targetPath}.tmp`, json, { encoding: "utf-8" });
      await fs_promises.rename(`${targetPath}.tmp`, targetPath);
    })
    .catch(error => warnLog("Inverter fault: failed to persist the alert state", targetPath, error));
}

/** Resolves once every queued save has landed (or failed loudly) */
export function flushFaultAlertStateWrites(): Promise<void> {
  return pendingWrite;
}

/** For selftests only: point the store at a scratch file */
export function useFaultAlertStatePathForTests(path: string) {
  statePath = path;
  lastSavedJson = undefined;
}

let statePath = fileURLToPath(new URL("../../inverter_fault_state.json", import.meta.url));
let lastSavedJson: string | undefined;
let pendingWrite: Promise<void> = Promise.resolve();

function isPersistedFaultAlerts(value: unknown): value is PersistedInverterFaultAlerts {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const lastSeen = candidate.last_seen_latest_fault as Record<string, unknown> | null | undefined;
  const pending = candidate.pending_new_fault as Record<string, unknown> | null | undefined;
  return (
    isPersistedEpisodeOrNull(candidate.fault_mode) &&
    isPersistedEpisodeOrNull(candidate.bypass) &&
    (lastSeen === null ||
      (typeof lastSeen === "object" && typeof lastSeen.code === "number" && typeof lastSeen.record_id === "number")) &&
    (pending === null ||
      (typeof pending === "object" &&
        typeof pending.code === "number" &&
        typeof pending.text === "string" &&
        typeof pending.previous_code === "number" &&
        typeof pending.observed_at_ms === "number"))
  );
}

function isPersistedEpisodeOrNull(value: unknown): value is PersistedModeEpisode | null {
  if (value === null) return true;
  if (typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.onset_ms === "number" &&
    typeof candidate.onset_known === "boolean" &&
    typeof candidate.last_reading_at_ms === "number" &&
    (candidate.alerted_severity === null || ["P1", "P2", "P3"].includes(String(candidate.alerted_severity))) &&
    (candidate.alerted_at_ms === null || typeof candidate.alerted_at_ms === "number") &&
    (candidate.alerted_fault_code === null || typeof candidate.alerted_fault_code === "number")
  );
}
