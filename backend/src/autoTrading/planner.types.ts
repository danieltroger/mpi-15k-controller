import type { AutomaticTradingConfig, ExpectedSpotSource, MeterCalibration } from "../config/config.types.ts";
import type { ForecastSpotSummary } from "./expectedSpotForecast.types.ts";

export type PriceSlot15 = { startMs: number; spot: number };
export type FixedWindow = { startMs: number; endMs: number; watts: number };
/**
 * Knobs are the automatic_trading config section verbatim (spread it in), plus what lives elsewhere
 * in the config: the runtime sell cutoff, the baseline night feed and the meter calibration.
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
  | "terminal_value_mode"
  | "terminal_value_scale"
  | "terminal_value_trailing_days"
  | "terminal_value_months"
  | "terminal_value_min_saving_sek_per_kwh"
  | "terminal_value_forecast_max_deviation_sek"
  | "terminal_value_forecast_max_age_hours"
  | "terminal_value_forecast_wait_seconds"
  | "hold_enabled"
  | "hold_power_watts"
  | "hold_overhead_watts"
  | "hold_margin_sek_per_kwh"
  | "hold_min_window_minutes"
  | "hold_bridge_minutes"
> & {
  /** scheduled_power_selling.only_sell_above_soc — where the runtime cuts selling off */
  runtime_soc_floor_percent: number;
  /** feed_from_battery_when_no_solar.feed_amount_watts */
  baseline_feed_watts: number;
  /** The meter_calibration section, corrected to its bounds: revenue is credited at what the meter counts (simulate.ts) */
  meter_calibration: MeterCalibration;
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
  /**
   * A hold window of ours running at nowMs, in a re-plan that keeps the running windows (runningHold.ts): not
   * in fixedBuys. When the plan models holds it holds through the current quarter as written and is re-planned
   * from the next one on (PlanResult.runningHoldReshaped); otherwise it is planned around as given, whole.
   */
  runningHold?: FixedWindow;
  /** Time ranges where the user deleted an auto-created window — the planner must not re-add there. */
  sellVetoWindows: { startMs: number; endMs: number }[];
  buyVetoWindows: { startMs: number; endMs: number }[];
  /**
   * The spot price expected after the priced horizon (expectedSpot.ts), estimated when the terminal value
   * is on and in season (terminalValue.ts): the end-of-plan energy and the unpriced tail are priced at it.
   * Absent, or without a value, the plan runs with no terminal value and its notes say why.
   */
  expectedSpot?: ExpectedSpotEstimate;
  knobs: PlannerKnobs;
};
/**
 * p̂, the expected spot (SEK/kWh) after the priced horizon, and where it came from. expectedSpot is
 * undefined when it couldn't be estimated (detail says why).
 */
export type ExpectedSpotEstimate = {
  expectedSpot: number | undefined;
  /** Where the value came from: "trailing" also when the "forecast" mode fell back to it */
  source: ExpectedSpotSource;
  /** What the value is ("7-day mean spot"), or why there is none — quoted in the plan notes */
  detail: string;
  /** terminal_value_mode "forecast" only: the outlook the value came from, or why the trailing mean stood in */
  forecast?: ForecastSpotSummary;
};
/**
 * How simulate prices what lies past the published prices. Every trial of one plan shares one, so
 * the revenueSek the allocation passes compare all count the same things.
 */
export type HorizonValuation = {
  /** Spot assumed for the unpriced constraint tail */
  tailSpot: number;
  /**
   * SEK credited per DC kWh still above the emergency floor when the simulation ends (terminalValue.ts);
   * 0 = the energy left at the end is worth nothing
   */
  endEnergySekPerKwh: number;
};
export type PlannedWindow = {
  startMs: number;
  endMs: number;
  watts: number;
  kind: "sell" | "buy";
  /**
   * A buy window that holds (holdAllocation.ts): the house runs from the grid at a trickle charge so the
   * battery keeps its energy. Absent on every other window.
   */
  hold?: true;
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
  /** Cash: what the plan's grid trades earn minus what its imports cost, over the horizon and the tail */
  estimatedRevenueSek: number;
  /** Cash, the same accounting for the no-trade projection */
  baselineRevenueSek: number;
  /**
   * Value of the energy left at plan end (terminalValue.ts), not cash and not in the two figures above —
   * the planner maximises their sum with it. Only present while the terminal value applies.
   */
  endEnergyValueSek?: number;
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
  /**
   * The plan re-planned PlannerInput.runningHold from the next quarter on: `buys` then holds a hold window
   * keyed at its start (through at least the current quarter), which replaces it. Absent when there was none,
   * or the plan only planned around it as given (the caller keeps it then).
   */
  runningHoldReshaped?: true;
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
  /**
   * The hold power planned in this slot (holdAllocation.ts), 0 = none. Part of the candidate schedule like
   * sellW/buyW, but kept on the slot so every pass's simulations see the holds without passing them along;
   * a sell or buy the later passes put into the slot wins over it (simulate.ts), and only the hold pass
   * sets or clears it. buildSlots starts every slot at 0.
   */
  holdW: number;
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
  /** Everything drawn from the grid: the shortfall below, plus what buy windows draw for the battery and the house */
  importWh: number;
  /** The import an empty battery forces (the house's deficit at the emergency floor) — what pre-buying averts */
  shortfallImportWh: number;
  boughtWh: number;
  socAfterSlot: number[];
  /** Average auto-export watts per slot (battery-full PV overflow) — 0 in slots without it */
  autoExportWPerSlot: number[];
  /** The terminal value credited for the energy left at the end (HorizonValuation), included in revenueSek */
  endEnergyValueSek: number;
};

/**
 * What the pre-buy pass (buyAllocation.ts) hands back: the plan with its buys, the accepted buy slots, which of
 * them only stock up for after the horizon, and how much those buy
 */
export type PreBuyResult = {
  result: SimResult;
  acceptedBuy: number[];
  stockingBuySlots: Set<number>;
  stockedKwh: number;
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
  valuation: HorizonValuation;
  /** Whether a trial breaches the floor no worse than the no-trade projection already does */
  feasibleVsBase: (result: SimResult) => boolean;
};
