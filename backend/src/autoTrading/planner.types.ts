import type { AutomaticTradingConfig } from "../config/config.types.ts";

export type PriceSlot15 = { startMs: number; spot: number };
export type FixedWindow = { startMs: number; endMs: number; watts: number };
/**
 * Knobs are the automatic_trading config section verbatim (spread it in), plus two values
 * that live elsewhere in the config: the runtime sell cutoff and the baseline night feed.
 */
export type PlannerKnobs = Pick<
  AutomaticTradingConfig,
  | "max_sell_power_watts"
  | "inverter_max_ac_output_watts"
  | "max_buy_power_watts"
  | "planner_soc_floor_percent"
  | "planner_soc_floor_sunny_percent"
  | "emergency_soc_floor_percent"
  | "extra_reserve_kwh"
  | "min_sell_spot_sek_per_kwh"
  | "min_gain_sek_per_slot"
  | "min_window_minutes"
  | "charge_efficiency"
  | "discharge_efficiency"
  | "buy_surcharges_sek_per_kwh"
  | "vat_multiplier"
  | "sell_bonus_sek_per_kwh"
  | "min_buy_saving_sek_per_kwh"
  | "sell_ramp_minutes"
  | "sell_restart_penalty_sek"
  | "allow_arbitrage_buying"
> & {
  /** scheduled_power_selling.only_sell_above_soc — where the runtime cuts selling off */
  runtime_soc_floor_percent: number;
  /** feed_from_battery_when_no_solar.feed_amount_watts */
  baseline_feed_watts: number;
};
export type PlannerInput = {
  nowMs: number;
  /** Sorted, contiguous 15-min spot price slots (today + tomorrow when available). May include past slots. */
  prices: PriceSlot15[];
  /** Solar production forecast in watts at a given time. Must cover the price horizon plus the constraint tail. */
  solarWattsAt: (ms: number) => number;
  /** House consumption forecast (AC output) in watts, excluding inverter parasitic draw. */
  houseLoadWattsAt: (ms: number) => number;
  parasiticWatts: number;
  socPercent: number;
  capacityWh: number;
  /** Hours past the end of price data to keep enforcing SOC constraints (covers the night after the last priced day). */
  constraintTailHours: number;
  /** Schedule windows owned by the user — treated as immutable and simulated as given. */
  fixedSells: FixedWindow[];
  fixedBuys: FixedWindow[];
  /** Time ranges where the user deleted an auto-created window — the planner must not re-add there. */
  sellVetoWindows: { startMs: number; endMs: number }[];
  buyVetoWindows: { startMs: number; endMs: number }[];
  knobs: PlannerKnobs;
};
export type PlannedWindow = {
  startMs: number;
  endMs: number;
  watts: number;
  kind: "sell" | "buy";
  reason: string;
  expectedKwh: number;
  avgSpot: number;
};
export type PlanProjection = {
  startSocPercent: number;
  minSocPercent: number;
  minSocAt: string;
  endSocPercent: number;
  plannedSellKwh: number;
  autoExportKwh: number;
  unavoidableImportKwh: number;
  plannedBuyKwh: number;
  estimatedRevenueSek: number;
  baselineRevenueSek: number;
};
export type PlanResult = {
  sells: PlannedWindow[];
  buys: PlannedWindow[];
  notes: string[];
  projection: PlanProjection;
};
export type Slot = {
  startMs: number;
  endMs: number;
  durationH: number;
  spot: number | undefined;
  pvW: number;
  houseW: number;
  fixedSellW: number;
  fixedBuyW: number;
};
export type SimResult = {
  /** Cash revenue projection (fees included, restart penalty NOT — comparable to settled reality) */
  revenueSek: number;
  /** Fictional churn charge per sell-run start; the optimizer maximizes revenueSek − restartPenaltySek */
  restartPenaltySek: number;
  violationWh: number;
  minSocWh: number;
  minSocMs: number;
  endSocWh: number;
  sellExportWh: number;
  autoExportWh: number;
  importWh: number;
  boughtWh: number;
  socAfterSlot: number[];
};
