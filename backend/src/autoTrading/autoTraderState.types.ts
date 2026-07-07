import type { PlanProjection } from "./planner.types.ts";

/**
 * Pure type declarations for the auto trader's persisted state and its published status. Kept free
 * of runtime imports (no fs/path/process) so the frontend can import AutoTraderStatus directly and
 * the two sides can't drift. The runtime helpers live in autoTraderState.ts, which re-exports these.
 */

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
   * can be compared against reality. Empty until the first plan; pruned to a handful of recent days.
   */
  forecast_log: Record<string, DayForecast>;
  /**
   * Most recent local date (YYYY-MM-DD) whose realized performance has been measured + written.
   * Genuinely absent until the first day settles (distinct from any real date), so it stays optional.
   */
  last_settled_date?: string;
};

/**
 * The status snapshot published over the ws `autoTraderStatus` accessor and rendered by the frontend
 * AutoTraderPanel — a projection of AutoTraderState plus two runtime fields (`enabled`,
 * `next_daily_run_at`). The reporting fields are optional because the bootstrap states
 * ("starting", "disabled") carry only `enabled` and a `note`. Imported by both backend and
 * frontend so the wire shape has a single source of truth.
 */
export type AutoTraderStatus = {
  enabled: boolean;
  note?: string;
  next_daily_run_at?: string;
  last_plan?: AutoTraderState["last_plan"];
  vetoes?: AutoTraderState["vetoes"];
  guard?: AutoTraderState["guard"];
  last_error?: AutoTraderState["last_error"];
  owned_selling_windows?: number;
  owned_buying_windows?: number;
};
