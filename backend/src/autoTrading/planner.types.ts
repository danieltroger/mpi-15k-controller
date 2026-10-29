import type { AutomaticTradingConfig } from "../config/config.types.ts";

export type PriceSlot15 = { startMs: number; spot: number };
export type FixedWindow = { startMs: number; endMs: number; watts: number };
/**
 * Knobs are the automatic_trading config section verbatim (spread it in), plus two values
 * that live elsewhere in the config: the runtime sell cutoff and the baseline night feed.
 * The callers pass the knobs of plannerKnobBounds.ts corrected to their bounds.
 */
export type PlannerKnobs = Pick<
  AutomaticTradingConfig,
  | "max_sell_power_watts"
  | "min_sell_power_watts"
  | "inverter_max_ac_output_watts"
  | "max_buy_power_watts"
  | "planner_soc_floor_percent"
  | "planner_soc_floor_sunny_percent"
  | "emergency_soc_floor_percent"
  | "extra_reserve_kwh"
  | "min_sell_spot_sek_per_kwh"
  | "min_gain_sek_per_slot"
  | "min_window_minutes"
  | "fragmentation_tolerance_sek_per_window"
  | "charge_efficiency"
  | "discharge_efficiency"
  | "buy_surcharges_sek_per_kwh"
  | "vat_multiplier"
  | "sell_bonus_sek_per_kwh"
  | "min_buy_saving_sek_per_kwh"
  | "sell_ramp_minutes"
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
  /**
   * Mean solar forecast over [startMs, endMs). The physical model steps every 10 min, so a 15-min
   * slot's midpoint alone would skip a sub-step; slots and hours integrate through this when given.
   */
  solarAverageWattsBetween?: (startMs: number, endMs: number) => number;
  /** House consumption forecast (AC output) in watts, excluding inverter parasitic draw. */
  houseLoadWattsAt: (ms: number) => number;
  parasiticWatts: number;
  socPercent: number;
  capacityWh: number;
  /** Hours past the end of price data to keep enforcing SOC constraints (covers the night after the last priced day). */
  constraintTailHours: number;
  /** Schedule windows owned by the user — treated as immutable and simulated as given. */
  fixedSells: FixedWindow[];
  /**
   * The sell entries the runtime is executing: the whole config schedule, the user's and ours, ended
   * ones included. Only tells the simulation which window is feeding at nowMs and, without a
   * measuredFeedInW, how far its feed-in has ramped up (runningFeedAtNow) — what may be planned is
   * still decided by fixedSells. Without it, fixedSells stand in.
   */
  runningSellSchedule?: FixedWindow[];
  /**
   * The grid export the inverter measured at nowMs (W, ≥ 0), when the trader has a fresh reading
   * (measuredFeedIn.ts). A sell window running at nowMs starts the simulation from it, capped at the
   * window's target, instead of from a ramp replayed over the schedule (runningFeedAtNow).
   */
  measuredFeedInW?: number;
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
/**
 * One 15-min step of the plan's projected battery trajectory: SOC after the slot ran, plus the
 * average power the sim expects to auto-export in it (battery full, surplus PV flowing to grid).
 * autoExportW is optional on the wire — plans persisted before it exist without it.
 */
export type SocSeriesPoint = { startMs: number; socPercent: number; autoExportW?: number };
export type PlanResult = {
  sells: PlannedWindow[];
  buys: PlannedWindow[];
  notes: string[];
  projection: PlanProjection;
  /** Projected SOC per slot under the final plan — the frontend chart draws this as a line. */
  socSeries: SocSeriesPoint[];
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
  /**
   * Feed-in a sell window running at nowMs has already ramped up to when this slot starts
   * (runningFeedAtNow). Only slot 0's is read — the simulation carries the feed level on from
   * there — so buildSlots leaves the others at 0.
   */
  feedInAtStartW: number;
  /**
   * When the sell window running at nowMs started (its schedule key), undefined when none is. Only
   * slot 0's is set: a new window that continues that feed is keyed no earlier (planWindows.ts).
   */
  runningWindowStartMs: number | undefined;
};
export type SimResult = {
  revenueSek: number;
  violationWh: number;
  minSocWh: number;
  minSocMs: number;
  endSocWh: number;
  sellExportWh: number;
  /**
   * sellExportWh per slot: what a sell exports there, the ramp and the house-load cap included — 0 in
   * slots without a sell. A planned window's expected energy is the sum over its slots.
   */
  sellExportWhPerSlot: number[];
  autoExportWh: number;
  importWh: number;
  boughtWh: number;
  socAfterSlot: number[];
  /** Average auto-export watts per slot (battery-full PV overflow) — 0 in slots without it */
  autoExportWPerSlot: number[];
};

/**
 * What generatePlan's sell and buy allocation passes (sellAllocation.ts, buyAllocation.ts) work on.
 * sellW and buyW are the candidate schedule, per slot: the passes trial a change by setting it,
 * simulating, and either keeping it or zeroing it again, so they mutate these arrays in place.
 */
export type AllocationContext = {
  input: PlannerInput;
  slots: Slot[];
  sellW: number[];
  buyW: number[];
  tailSpot: number;
  /** Whether a trial breaches the floor no worse than the no-trade projection already does */
  feasibleVsBase: (result: SimResult) => boolean;
};
