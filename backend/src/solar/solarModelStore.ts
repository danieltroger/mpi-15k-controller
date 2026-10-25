import { promises as fs_promises } from "fs";
import { fileURLToPath } from "url";
import { errorLog } from "../utilities/logging.ts";
import type { SolarModelState } from "./solarModel.types.ts";

/**
 * The machine-owned fitted state, backend/solar_model_state.json (gitignored). Kept out of
 * config.json: the mask is a few hundred numbers no human edits, and the config file is written
 * on every knob change. Deleting the file is safe — the next start refits from history (about a
 * minute), forecasting with the default horizon mask meanwhile.
 */
export async function loadSolarModelState(): Promise<SolarModelState | undefined> {
  if (cachedState.loaded) return cachedState.value;
  try {
    const parsed = JSON.parse(await fs_promises.readFile(STATE_FILE_PATH, { encoding: "utf-8" })) as SolarModelState;
    cachedState.value = parsed.version === 1 ? parsed : undefined;
    if (!cachedState.value)
      errorLog("Solar model: state file has an unknown version — ignoring it and refitting", parsed.version);
  } catch (error) {
    // Missing file = first start; anything else means the fit is lost and must be loud
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      errorLog("Solar model: failed to read the state file — refitting from history", STATE_FILE_PATH, error);
    }
    cachedState.value = undefined;
  }
  cachedState.loaded = true;
  return cachedState.value;
}

export async function saveSolarModelState(state: SolarModelState) {
  cachedState.value = state;
  cachedState.loaded = true;
  try {
    await fs_promises.writeFile(STATE_FILE_PATH, JSON.stringify(state, null, 2), { encoding: "utf-8" });
  } catch (error) {
    errorLog("Solar model: failed to persist the state file — the fit only lives until restart", error);
  }
}

export const STATE_FILE_PATH = fileURLToPath(new URL("../../solar_model_state.json", import.meta.url));

const cachedState: { loaded: boolean; value: SolarModelState | undefined } = { loaded: false, value: undefined };
