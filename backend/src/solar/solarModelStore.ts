import { promises as fs_promises } from "fs";
import { fileURLToPath } from "url";
import { errorLog, logLog, warnLog } from "../utilities/logging.ts";
import type { SolarModelState } from "./solarModel.types.ts";

/**
 * The machine-owned fitted state, backend/solar_model_state.json (gitignored). Kept out of
 * config.json: the mask is a few hundred numbers no human edits, and the config file is written
 * on every knob change. Every load re-checks the file's mtime, so a state file copied in (the
 * bootstrap from the VM) or deleted (to refit a changed plant from scratch) takes effect without
 * a restart. Writes are atomic (temp file + rename): a torn write must never cost a refit.
 */
export async function loadSolarModelState(): Promise<SolarModelState | undefined> {
  let fileStats: { mtimeMs: number; size: number };
  try {
    fileStats = await fs_promises.stat(STATE_FILE_PATH);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      warnLog("Solar model: can't stat the state file — keeping the state already loaded", error);
      return cache.state;
    }
    if (cache.signature !== MISSING) {
      if (cache.state) logLog("Solar model: state file is gone — refitting from scratch at the next check");
      cache = { signature: MISSING, state: undefined };
    }
    return undefined;
  }
  const signature = `${fileStats.mtimeMs}:${fileStats.size}`;
  if (signature === cache.signature) return cache.state;
  try {
    const parsed = JSON.parse(await fs_promises.readFile(STATE_FILE_PATH, { encoding: "utf-8" })) as SolarModelState;
    if (parsed.version !== 2) throw new Error(`unknown state file version ${parsed.version}`);
    cache = { signature, state: parsed };
    corruptSignaturePaged = undefined;
  } catch (error) {
    // Loud, but once per broken file version: the next accepted refit overwrites it atomically
    const report = corruptSignaturePaged === signature ? warnLog : errorLog;
    report(
      "Solar model: unreadable state file — forecasting on the default mask until a refit replaces it",
      STATE_FILE_PATH,
      error
    );
    corruptSignaturePaged = signature;
    cache = { signature, state: undefined };
  }
  return cache.state;
}

export async function saveSolarModelState(state: SolarModelState) {
  const temporaryPath = `${STATE_FILE_PATH}.tmp`;
  await fs_promises.writeFile(temporaryPath, JSON.stringify(state, null, 2), { encoding: "utf-8" });
  await fs_promises.rename(temporaryPath, STATE_FILE_PATH);
  const fileStats = await fs_promises.stat(STATE_FILE_PATH);
  cache = { signature: `${fileStats.mtimeMs}:${fileStats.size}`, state };
}

export const STATE_FILE_PATH = fileURLToPath(new URL("../../solar_model_state.json", import.meta.url));

const MISSING = "missing";
/** Module-level on purpose: survives index.ts's in-process main() restarts */
let cache: { signature: string | undefined; state: SolarModelState | undefined } = {
  signature: undefined,
  state: undefined,
};
let corruptSignaturePaged: string | undefined;
