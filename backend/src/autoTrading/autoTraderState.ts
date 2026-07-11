import { promises as fs_promises } from "fs";
import path from "path";
import process from "process";
import { errorLog } from "../utilities/logging.ts";
import type { AutoTraderState } from "./autoTraderState.types.ts";

export type {
  AutoTraderState,
  AutoTraderStatus,
  StateWindow,
  DayForecast,
  RealizedDay,
} from "./autoTraderState.types.ts";

export const EMPTY_STATE: AutoTraderState = {
  owned_entries: { selling: {}, buying: {} },
  vetoes: [],
  forecast_log: {},
};

export async function loadAutoTraderState(): Promise<AutoTraderState> {
  try {
    const raw = await fs_promises.readFile(stateFilePath(), { encoding: "utf-8" });
    return { ...EMPTY_STATE, ...JSON.parse(raw) };
  } catch (e) {
    // Missing file is the normal first boot; anything else (corrupt JSON, IO error) means we lost
    // track of which schedule entries are ours and must be loud about it.
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") {
      errorLog(
        "Auto trader: failed to load state file — starting with empty state, ownership of existing schedule entries is lost",
        e
      );
    }
    return structuredClone(EMPTY_STATE);
  }
}

export async function saveAutoTraderState(state: AutoTraderState) {
  try {
    await fs_promises.writeFile(stateFilePath(), JSON.stringify(state, null, 2), { encoding: "utf-8" });
  } catch (e) {
    errorLog("Auto trader: failed to persist state file", e);
  }
}

function stateFilePath() {
  return path.dirname(process.argv[1]) + "/../auto_trader_state.json";
}
