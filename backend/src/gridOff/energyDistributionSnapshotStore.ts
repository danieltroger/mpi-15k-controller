/**
 * The energy-distribution snapshot across restarts, in backend/grid_off_settings_snapshot.json (gitignored):
 * the HECS fields the restore puts back, as read in 050 just before the latest DM151 request. Written when
 * DM151 is requested, removed once a restore to it has landed, so a controller restart in the middle of an
 * episode still knows what "normal" was. A missing file is the normal case (no episode open) and quiet;
 * anything else unreadable is an errorLog, and the restore falls back on grid_off.normal_energy_distribution.
 */
import { readFileSync, promises as fs_promises } from "fs";
import { fileURLToPath } from "url";
import type { NormalEnergyDistribution } from "../config/config.types.ts";
import { errorLog } from "../utilities/logging.ts";
import { effectiveNormalEnergyDistribution } from "./energyDistributionProfile.ts";

/** snake_case like the other machine-owned state files */
export type EnergyDistributionSnapshot = {
  /** Wall-clock ms the HECS it was taken from was decoded */
  taken_at: number;
  profile: NormalEnergyDistribution;
};

export type EnergyDistributionSnapshotStore = {
  /** Synchronous: the switch's status needs it before the first readback */
  load: () => EnergyDistributionSnapshot | undefined;
  save: (snapshot: EnergyDistributionSnapshot) => void;
  clear: () => void;
};

const DEFAULT_SNAPSHOT_PATH = fileURLToPath(new URL("../../grid_off_settings_snapshot.json", import.meta.url));

export function createEnergyDistributionSnapshotFileStore(
  statePath: string = DEFAULT_SNAPSHOT_PATH
): EnergyDistributionSnapshotStore {
  const writes: SnapshotWrites = { pending: Promise.resolve() };
  return {
    load: () => loadSnapshot(statePath),
    save: snapshot => queueWrite(writes, () => writeSnapshot(statePath, snapshot), statePath),
    clear: () => queueWrite(writes, () => removeSnapshot(statePath), statePath),
  };
}

/** Chained, so a save and a clear can't race on the file */
type SnapshotWrites = { pending: Promise<void> };

function loadSnapshot(statePath: string): EnergyDistributionSnapshot | undefined {
  let fileText: string;
  try {
    fileText = readFileSync(statePath, { encoding: "utf-8" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    errorLog(
      "Grid off: couldn't read the energy-distribution snapshot",
      statePath,
      "— the restore uses grid_off.normal_energy_distribution",
      error
    );
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(fileText);
    const snapshot = validSnapshot(parsed);
    if (snapshot) return snapshot;
    errorLog(
      "Grid off: ignoring a malformed energy-distribution snapshot",
      statePath,
      fileText.slice(0, 300),
      "— the restore uses grid_off.normal_energy_distribution"
    );
  } catch (error) {
    errorLog("Grid off: ignoring an unparseable energy-distribution snapshot", statePath, error);
  }
  return undefined;
}

function validSnapshot(value: unknown): EnergyDistributionSnapshot | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.taken_at !== "number" || !Number.isFinite(candidate.taken_at)) return undefined;
  const { profile, corrections } = effectiveNormalEnergyDistribution(candidate.profile);
  return corrections.length ? undefined : { taken_at: candidate.taken_at, profile };
}

function queueWrite(writes: SnapshotWrites, write: () => Promise<void>, statePath: string): void {
  writes.pending = writes.pending
    .then(write)
    .catch(error => errorLog("Grid off: failed to update the energy-distribution snapshot", statePath, error));
}

/** Atomic (temp file + rename): a torn write must not leave a snapshot the next start can't read */
async function writeSnapshot(statePath: string, snapshot: EnergyDistributionSnapshot): Promise<void> {
  await fs_promises.writeFile(`${statePath}.tmp`, JSON.stringify(snapshot, null, 2), { encoding: "utf-8" });
  await fs_promises.rename(`${statePath}.tmp`, statePath);
}

async function removeSnapshot(statePath: string): Promise<void> {
  try {
    await fs_promises.unlink(statePath);
  } catch (error) {
    // Already gone is what clearing wants
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
}
