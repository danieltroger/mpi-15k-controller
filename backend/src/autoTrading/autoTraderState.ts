import { promises as fs_promises } from "fs";
import path from "path";
import process from "process";
import { errorLog } from "../utilities/logging.ts";
import type { PlanProjection } from "./planner.ts";

/** What the forecasts predicted for one local day, captured at plan time for later settlement. */
export type DayForecast = { predicted_pv_kwh: number; predicted_house_kwh: number; planned_sell_kwh: number };

export type StateWindow = {
  start: string;
  end: string;
  watts: number;
  kind: "sell" | "buy";
  reason: string;
  expected_kwh: number;
  avg_spot: number;
};

export type AutoTraderState = {
  last_plan?: {
    generated_at: string;
    trigger: string;
    horizon_end: string;
    projection: PlanProjection;
    notes: string[];
    windows: StateWindow[];
  };
  /** Exactly the schedule entries the auto trader wrote (used to tell ours from the user's) */
  owned_entries: {
    selling: Record<string, { end_time: string; power_watts: number }>;
    buying: Record<string, { end_time: string; charging_power: number }>;
  };
  /** Time ranges where the user deleted one of our windows — don't re-plan trades there until they pass */
  vetoes: { start: string; end: string; kind: "sell" | "buy"; noticed_at: string }[];
  last_error?: { at: string; message: string };
  guard?: { last_run_at: string; last_action: string };
  /**
   * What the forecasts predicted per local day (YYYY-MM-DD), captured at plan time so a settled day
   * can be compared against reality. Pruned to a handful of recent days.
   */
  forecast_log?: Record<string, DayForecast>;
  /** Most recent local date (YYYY-MM-DD) whose realized performance has been measured + written */
  last_settled_date?: string;
};

export const EMPTY_STATE: AutoTraderState = { owned_entries: { selling: {}, buying: {} }, vetoes: [] };

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
