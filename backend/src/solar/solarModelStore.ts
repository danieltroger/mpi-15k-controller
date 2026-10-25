import { promises as fs_promises } from "fs";
import { fileURLToPath } from "url";
import { errorLog, logLog, warnLog } from "../utilities/logging.ts";
import type { SolarModelState } from "./solarModel.types.ts";

/**
 * The machine-owned fitted state, backend/solar_model_state.json (gitignored). Kept out of
 * config.json: the mask is a few hundred numbers no human edits, and the config file is written
 * on every knob change. Every load re-checks the file's mtime, so a state file copied in (the
 * bootstrap from the VM) or deleted (to refit a changed plant from scratch) takes effect without
 * a restart. Writes are atomic (temp file + rename): a torn write must never cost a refit. When a
 * write fails (full SD card, read-only filesystem) the new state stays in memory — loads keep
 * returning it until the file itself changes or a later write succeeds.
 */
export async function loadSolarModelState(): Promise<SolarModelState | undefined> {
  const signature = await fileSignature();
  if (signature === undefined) return unsaved?.state ?? cache.state;
  if (unsaved) {
    if (unsaved.baseSignature === signature) return unsaved.state;
    logLog("Solar model: the state file changed since a failed save — following the file");
    unsaved = undefined;
  }
  if (signature === MISSING) {
    if (cache.signature !== MISSING && cache.state) logLog("Solar model: state file is gone — refitting from scratch");
    cache = { signature: MISSING, state: undefined };
    return undefined;
  }
  if (signature === cache.signature) return cache.state;
  try {
    const parsed = JSON.parse(await fs_promises.readFile(statePath, { encoding: "utf-8" })) as SolarModelState;
    if (parsed.version !== 2) throw new Error(`unknown state file version ${parsed.version}`);
    cache = { signature, state: parsed };
    corruptSignaturePaged = undefined;
  } catch (error) {
    // Loud, but once per broken file version: the next accepted refit overwrites it atomically
    const report = corruptSignaturePaged === signature ? warnLog : errorLog;
    report(
      "Solar model: unreadable state file — forecasting on the default mask until a refit replaces it",
      statePath,
      error
    );
    corruptSignaturePaged = signature;
    cache = { signature, state: undefined };
  }
  return cache.state;
}

/** Throws when the write fails — after keeping `state` in memory, so the caller only has to report it. */
export async function saveSolarModelState(state: SolarModelState) {
  // Can't stat now (a dying card)? Then the file is presumably what we last saw, not missing
  const baseSignature = (await fileSignature()) ?? cache.signature ?? MISSING;
  const temporaryPath = `${statePath}.tmp`;
  try {
    await fs_promises.writeFile(temporaryPath, JSON.stringify(state, null, 2), { encoding: "utf-8" });
    await fs_promises.rename(temporaryPath, statePath);
  } catch (error) {
    unsaved = { state, baseSignature };
    throw error;
  }
  unsaved = undefined;
  cache = { signature: (await fileSignature()) ?? MISSING, state };
}

export function solarModelStatePath(): string {
  return statePath;
}

/** For selftests only: point the store at a scratch file (and forget everything cached) */
export function useSolarModelStatePathForTests(path: string) {
  statePath = path;
  cache = { signature: undefined, state: undefined };
  unsaved = undefined;
}

const MISSING = "missing";
let statePath = fileURLToPath(new URL("../../solar_model_state.json", import.meta.url));
/** Module-level on purpose: survives index.ts's in-process main() restarts */
let cache: { signature: string | undefined; state: SolarModelState | undefined } = {
  signature: undefined,
  state: undefined,
};
/** A state whose save failed, valid while the file still looks like it did then */
let unsaved: { state: SolarModelState; baseSignature: string } | undefined;
let corruptSignaturePaged: string | undefined;

/** mtime:size, MISSING, or undefined when the file can't even be stat'ed (then keep what we have) */
async function fileSignature(): Promise<string | undefined> {
  try {
    const fileStats = await fs_promises.stat(statePath);
    return `${fileStats.mtimeMs}:${fileStats.size}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return MISSING;
    warnLog("Solar model: can't stat the state file — keeping the state already loaded", error);
    return undefined;
  }
}
