import type { ElpatronMode } from "../sharedTypes.ts";

export type AutomaticTradingConfig = {
  /** Master switch for the automatic day-ahead trading planner */
  enabled: boolean;
  /** elprisetjustnu.se price area, e.g. SE3 */
  price_area: string;
  /** When to generate the daily plan (HH:MM, Europe/Stockholm). Day-ahead prices publish ~13:00. */
  plan_at_local_time: string;
  latitude: number;
  longitude: number;
  /** power_watts written into generated sell windows */
  max_sell_power_watts: number;
  /**
   * The lowest power_watts the planner writes into a reduced-power sell window (a leftover budget
   * that no full-power slot fits). Bounds in plannerKnobBounds.ts, clamped by the backend.
   */
  min_sell_power_watts: number;
  /** Total AC the inverter can produce (house + export share it; house has priority). 15 kW nameplate. */
  inverter_max_ac_output_watts: number;
  /** charging_power written into generated buy windows (only used to avert unavoidable imports) */
  max_buy_power_watts: number;
  /** Planner keeps projected SOC above this (plus extra_reserve_kwh) at all times */
  planner_soc_floor_percent: number;
  /**
   * Reserve floor used instead of planner_soc_floor_percent while forecast PV covers the house —
   * with solar flowing, a forecast miss costs minutes of grid import, not a stranded night.
   * Keep ≤ planner_soc_floor_percent and ≥ the runtime cutoff (scheduled_power_selling.only_sell_above_soc).
   */
  planner_soc_floor_sunny_percent: number;
  /** Below this SOC the house effectively starts importing — used to price unavoidable imports */
  emergency_soc_floor_percent: number;
  /** Extra energy to keep in the battery on top of the floor, e.g. for charging the car. User knob. */
  extra_reserve_kwh: number;
  /** Don't bother selling below this spot price */
  min_sell_spot_sek_per_kwh: number;
  /** Minimum estimated revenue gain (SEK) for a 15-min slot to be worth scheduling */
  min_gain_sek_per_slot: number;
  /** Buying must beat the alternative by this much per kWh (import averting and arbitrage). Also covers battery wear. */
  min_buy_saving_sek_per_kwh: number;
  /** Buy cheap purely to re-sell at a later price peak when the spread beats fees + losses + margin */
  allow_arbitrage_buying: boolean;
  /**
   * Minutes the inverter takes to ramp grid feed-in from 0 to the full inverter_max_ac_output_watts
   * (grid safety). It's a rate: a smaller target is reached proportionally sooner, and a mid-run
   * step-up ramps too. Decreases are immediate.
   */
  sell_ramp_minutes: number;
  /** Generated windows shorter than this are dropped (inverter command churn isn't free) */
  min_window_minutes: number;
  charge_efficiency: number;
  discharge_efficiency: number;
  /** Per-kWh surcharges when buying, before VAT: grid transfer + energy tax + supplier markups */
  buy_surcharges_sek_per_kwh: number;
  vat_multiplier: number;
  /** Per-kWh extras when selling: supplier markup + nätnytta */
  sell_bonus_sek_per_kwh: number;
  /** How far past the priced horizon SOC constraints are enforced (covers the following night) */
  constraint_tail_hours: number;
  /** How often to re-check that the written schedule is still safe with live SOC (0 = off) */
  guard_interval_minutes: number;
  /** How often to look for a *better* plan under live conditions (0 = off). The guard only shrinks; this can grow. */
  opportunistic_replan_interval_minutes: number;
  /** A replacement plan must beat the current one's projected revenue by this much to be applied */
  opportunistic_replan_min_gain_sek: number;
  /** Retry interval while waiting for tomorrow's prices to publish */
  replan_retry_minutes: number;
  /** House load assumption if InfluxDB history is unavailable */
  fallback_house_load_watts: number;
  /** Physical per-string PV model (backend/src/solar/) — geometry and knobs; the fitted state lives in solar_model_state.json */
  solar_model: SolarModelConfig;
};

/** One PV string = one MPPT input. Owner-measured geometry; the monthly refit learns k, the sky factor and the shading mask. */
export type SolarStringSpec = {
  /** Panel tilt from horizontal */
  tilt_degrees: number;
  /** Compass direction the panels face: 180 = south, 270 = west, 300 = west-north-west */
  azimuth_degrees: number;
  /** Module nameplate total — only a plausibility bound for the fitted capacity, never used to predict */
  nameplate_kwp: number;
  /**
   * The MPPT input's current limit (23 A per connector in the manual). The model caps power at
   * max_current_amps × typical_mpp_volts; it has never bound in the history (max 10-min mean 22.65 A).
   */
  max_current_amps: number;
  typical_mpp_volts: number;
};

export type SolarModelConfig = {
  /** MPPT1 (solar_input_power_1) */
  string1: SolarStringSpec;
  /** MPPT2 (solar_input_power_2) */
  string2: SolarStringSpec;
  /**
   * The strings were re-wired at this instant: before it MPPT1 and MPPT2 were the two halves of
   * string 1's roof (so string 1 = MPPT1 + MPPT2 and string 2 has no history). Empty = never re-wired.
   */
  rewired_at: string;
  /** Oldest production history the refit reads (ISO date) */
  history_start: string;
  /** Re-fit the mask and capacities against actual production this often */
  refit_every_days: number;
  /**
   * Recency weighting of the refit: an observation this old counts half. Trees that stopped growing
   * make the mask nearly static; a cut-down tree is learned within one season of sun passing that sector.
   */
  mask_half_life_days: number;
  /** Irradiance the mask is fitted on: satellite (EUMETSAT SARAH-3, 2-day delay) or the forecast archive */
  mask_irradiance_source: "satellite" | "forecast_archive";
  /** Scale the forecast down per string while snow is likely on the panels, from each string's own recent production */
  snow_nowcast: boolean;
};

export type AlertingConfig = {
  /** Master switch — rules still run but nothing is recorded or sent when off */
  enabled: boolean;
  /** Log what would have been pushed instead of pushing (burn-in mode; cooldowns behave as live) */
  dry_run: boolean;
  /** Application API token from pushover.net/apps */
  pushover_app_token: string;
  /** A Pushover delivery-group key (whole family) or a single user key */
  pushover_recipient_key: string;
  /** Prefixed to every title so Örebro and Göteborg pushes are tellable apart */
  site_name: string;
  /** P1 when any battery probe (cell/bus-bar thermometers) reaches this; clears 3° lower */
  battery_temp_p1_celsius: number;
  /**
   * P2 when the hottest cooling_outlet_* probe reaches this — the early ventilation alarm. In the
   * 2025-06-30 shutdown (door + ventilation accidentally closed) outlets hit 39–41 °C vs a 34 °C
   * normal-summer peak, and would have crossed 36 °C ~80 min before the 100 °C cutoff. The
   * external-inlet probe sat flat at 24.5 °C through it, so it can't be the signal.
   */
  cooling_outlet_temp_p2_celsius: number;
  /** P2 below this pack voltage (16s LiFePO4 tolerates down to 2.5 V/cell = 40 V) */
  battery_undervoltage_p2_volts: number;
  /** P1 above this pack voltage (3.65 V/cell = 58.4 V is the charge ceiling) */
  battery_overvoltage_p1_volts: number;
  /** P1 when charging > 200 W with any battery probe at/below this (no charging below freezing) */
  charging_battery_temp_p1_celsius: number;
  /** P2 when no mqtt value has updated for this long (inverter USB daemon dead) */
  stale_mqtt_p2_minutes: number;
  /**
   * P2 when every thermometer has been silent for this long; never sooner than three
   * temperature_saving.thermometer_sweep_interval_seconds, so slow sweeps can't trip it
   */
  stale_temperatures_p2_minutes: number;
  /** Grid counts as down when ac_input_voltage_r sits below this … */
  grid_out_below_volts: number;
  /** … for at least this long (P2) */
  grid_out_p2_seconds: number;
  /**
   * P2 when the inverter's DC side looks latched off: the 2026-10-21 failure, where battery, PV and
   * grid charging all stayed dead for 59 h behind normal-looking telemetry until a power-cycle.
   * Three signatures (DC side idle / PV stalled in daylight / buy window not charging) share one
   * alert, followed by a quiet P3 once power flows again.
   */
  inverter_stuck_p2: boolean;
  /** How long the DC-side-idle and PV-stalled signatures must hold before the P2 */
  inverter_stuck_sustain_minutes: number;
  /** How long a confirmed grid-charge window may go without the battery charging before the P2 */
  inverter_stuck_buy_window_sustain_minutes: number;
  /**
   * Escalate to a P1 (pages through Do Not Disturb) when a signature is still observed failing this
   * long after the P2, never once a fix has shown up; 0 = never
   */
  inverter_stuck_p1_after_minutes: number;
  /**
   * P2 when the day-ahead PV forecast has been badly off for a week (rolling 7 days, two evaluations
   * in a row, once per episode, snow weeks excluded): 1 push in 26 months of backtest, the old linear model 8.
   */
  solar_forecast_accuracy_p2: boolean;
  /** …when actual/forecast PV over the week falls below this (only weeks forecasting ≥ 70 kWh) */
  solar_forecast_week_min_ratio: number;
  /** …or rises above this */
  solar_forecast_week_max_ratio: number;
  /** …or the summed daily misses exceed this share of the week's forecast (min 35 kWh) */
  solar_forecast_week_max_error_share: number;
  /**
   * P1 when the inverter itself reports Fault mode (PI17 MOD = 04) — the 2026-10-21 fault 14 latch
   * it held for 59 h. The page names the fault code and the power-cycle procedure. The episode
   * survives controller restarts within cooldown_minutes of its last reading (no second page);
   * after a longer downtime it pages again.
   */
  inverter_fault_mode_p1: boolean;
  /**
   * … once Fault mode has been read for this long (MOD is read once a minute, and at once when the
   * battery goes idle: at 60 s the page comes ~1.5 min after the fault, at most ~2.5 min)
   */
  inverter_fault_mode_p1_after_seconds: number;
  /**
   * P2 when the inverter records a new fault code (PI17 CFS changes) that isn't already paged as
   * Fault mode — e.g. one it recovered from by itself
   */
  inverter_fault_code_p2: boolean;
  /** P2 when the inverter sits in Bypass mode (house straight on the grid, no backup) with the grid present … */
  inverter_bypass_p2: boolean;
  /** … for at least this long */
  inverter_bypass_p2_after_seconds: number;
  /** Forward every errorLog() as a deduped P2 */
  error_log_p2: boolean;
  /**
   * P2 when the trading guard sheds windows after a projected reserve breach. Off by default:
   * three weeks of live operation showed this is the guard doing its routine job (36 of 50 recent
   * alerts), not a hazard — and the failure modes that *are* worth waking up for (the re-plan
   * itself erroring out) already page via error_log_p2.
   */
  trading_guard_p2: boolean;
  /** Quiet P3 pushes for the daily plan + settlement results */
  digest_p3: boolean;
  /** Per-alert-key re-send suppression window */
  cooldown_minutes: number;
  /** Global cap (P1 exempt) so a bug can't machine-gun the family or the API quota */
  max_pushes_per_hour: number;
  /** Separate hourly budget for forwarded-errorLog P2s so log noise can't crowd out threshold-rule alerts */
  max_errorlog_pushes_per_hour: number;
  /** No staleness alerts this soon after boot — sensors come up in their own time */
  startup_grace_seconds: number;
};

export type TemperatureSavingConfig = {
  database: string;
  table: string;
  /**
   * Start-to-start time between two sweeps of the 1-wire thermometers (one bulk conversion, then
   * every probe read: ~1.2 s). 0, or anything shorter than a sweep, sweeps back to back; sweeps
   * never overlap. At most 60, so the battery P1 is at most ~1 min late. Live: applies from the
   * next sweep, a running wait is re-measured.
   * Bounds of all thermometer_* settings: temperatureMeasuring/thermometerSweepSettings.ts.
   */
  thermometer_sweep_interval_seconds: number;
  /**
   * One probe without an accepted reading pages (errorLog → P2) after this long or after 3 failed
   * sweeps in a row, whichever is later: temperatures-stale only sees all probes going silent.
   * 1–60, default 5. Live.
   */
  thermometer_silent_page_after_minutes: number;
  /**
   * While the 1-wire bulk read fails (sweeps then read probe by probe, ~11 s), how often a sweep tries
   * it again. 10–3600, default 60. Live: a change applies from the next sweep.
   */
  thermometer_bulk_retry_interval_seconds: number;
};

export type Config = {
  automatic_trading: AutomaticTradingConfig;
  alerting: AlertingConfig;
  usb_parameter_setting: {
    /**
     * Minimum time between two changes of the same analog setter target: the AC charging current
     * (MUCHGC) and the feed-in limit (GPMP). A buy window starting or ending, feeding switching
     * mode, the first target after a start and the on/off switches are never held. At least 15:
     * nothing else spaces writes since #52, and a shorter blip can page a field as never applied (a
     * smaller value is raised to 15 with a warning). Default 45, 15–300. Live. See
     * inverterComms/setterChangeThrottle.ts.
     */
    min_seconds_between_setting_changes: number;
    /**
     * An AC charging current target at least this many amps (battery side) below the last one goes
     * out at once, whatever the interval above: a load coming on mid-window must not overload a
     * phase while the old current is held. Default 10, 0–30. Live.
     */
    ac_charging_current_immediate_decrease_amps: number;
    /**
     * Cadence of the slow settings poll (GPMP/HECS/BATS). GS+PS poll continuously at the serial
     * engine's own natural rate; targeted confirms after writes happen regardless of this value.
     */
    poll_values_interval_seconds: number;
  };
  current_measuring: {
    table: string;
    rate_constant: number;
    average_over_time_ms: number;
    /**
     * What voltage the hall effect sensor outputs at 0A
     */
    zero_current_millivolts: number;
    millivolts_per_ampere: number;
    /**
     * For the second sensor
     */
    zero_current_millivolts2: number;
    millivolts_per_ampere2: number;
    /**
     * Just a flag here for debugging issues with the i2c sensor.
     */
    enabled: boolean;
  };
  scheduled_power_selling: {
    schedule: Record<
      string,
      {
        end_time: string;
        power_watts: number;
      }
    >;
    only_sell_above_soc: number;
    start_selling_again_above_soc: number;
    start_selling_again_above_voltage: number;
    only_sell_above_voltage: number;
    /**
     * Selling stops (every sell window feeds 0) once component_max_temperature reaches this, and a
     * P1 goes out. The inverter latches fault 57 at 100 °C and stays off until power-cycled: on
     * 2025-06-30 it got there after 2 h 20 min of ~14 kW selling with the room's ventilation shut.
     */
    only_sell_below_inverter_temp_celsius: number;
    /** …and resumes (quiet P3) only once it has cooled below this — the gap keeps it from flapping */
    start_selling_again_below_inverter_temp_celsius: number;
  };
  scheduled_power_buying: {
    schedule: Record<
      string,
      {
        end_time: string;
        charging_power: number;
      }
    >;
    only_buy_below_soc: number;
    start_buying_again_below_soc: number;
    max_grid_input_amperage: number;
  };
  influxdb?: {
    host: string;
    database: string;
    username: string;
    password: string;
  };
  soc_calculations: {
    battery_empty_at: number;
    table: string;
    /**
     * Coulomb-counting (Ah) SOC ledger — the single SOC system (the old Wh integrate-and-fit system and
     * its Wh-fitter knobs — the persisted capacity/parasitic state and the fitter search ranges — are gone).
     * Anchored at the latest full/empty/soft-empty event and integrated from hall sensor 2 amps:
     *   SOC = anchor_soc + (∫amps·dt − drain_a·elapsed_h) / capacity_ah · 100
     * `drain_a` (sensor zero-bias + parasitic, seasonal) and `capacity_ah` are tracked online (EMA) and
     * persisted here across restarts.
     */
    ah_ledger: {
      /** Usable pack capacity in amp-hours (16S LiFePO4). Online-tracked from deep full↔empty spans. */
      capacity_ah: number;
      /** Constant amp offset subtracted each hour (hall zero-bias + parasitic). Online-tracked, seasonal. */
      drain_a: number;
      /** Mean discharge-branch terminal voltage (Phase 0 V-bar). Recorded for reference; unused in Phase 1. */
      v_discharge: number;
      /** Mean charge-branch terminal voltage (Phase 0 V-bar). Recorded for reference; unused in Phase 1. */
      v_charge: number;
      /** EMA time constant (days) for the drain update weight w = 1 − exp(−dt_days / tau). */
      drain_ema_tau_days: number;
      /**
       * Soft-empty anchor — the pack often only drains to ~49 V, not the 46 V hard empty. A downward
       * crossing of `voltage` while nearly at rest (|amps| < max_abs_amps) anchors the Ah ledger (only)
       * at `soc_percent`.
       */
      soft_empty: {
        voltage: number;
        max_abs_amps: number;
        soc_percent: number;
      };
    };
  };
  elpatron_switching: {
    /** Let this controller gate the water heater element by solar (write-gpio to the heating pi) */
    enabled: boolean;
    /**
     * Off / always-on / solar-gated. Optional because configs predating it only carry `enabled` —
     * always read through resolveElpatronMode (sharedTypes.ts), which falls back accordingly.
     */
    mode?: ElpatronMode;
    /** Solar watts above which the element is allowed on */
    min_solar_input: number;
    /** The pi running github.com/danieltroger/heating (ws server on :9321 owns the element GPIO) */
    heating_pi_ip: string;
    /** Measured element draw when on: ~2.05 kW × 3 phases (2026-07 measurement, ~7 kW nameplate) */
    element_watts: number;
    /**
     * Effective heat capacity at the tank sensor (Wh per °C) — calibrated from a 2026-07-10 burn:
     * 6.2 kW × 0.7 h moved the sensor +9.1 °C. Used to predict burn length and standing losses.
     */
    tank_wh_per_degree: number;
    /** Observed tank cooling rate with the element off (standing loss, °C per hour) */
    tank_cooling_degrees_per_hour: number;
    /** The tank thermostat cuts the element around this temperature (kept low — the room warms up) */
    tank_max_temperature: number;
  };
  stop_charging_below_current: number;
  full_battery_voltage: number;
  float_charging_voltage: number;
  start_bulk_charge_voltage: number;
  thermometers: { [key: string]: string };
  mqtt_host: string;
  temperature_saving: TemperatureSavingConfig;
  feed_from_battery_when_no_solar: {
    feed_below_available_power: number;
    feed_amount_watts: number;
    increment_with_on_peak: number;
    // seconds
    peak_increment_duration: number;
    max_feed_in_power_when_feeding_from_solar: number;
    add_to_feed_below_when_currently_feeding: number;
    disable_below_battery_voltage: number;
    should_feed_debounce_time: number;
    allow_switching_to_solar_feeding_during_charging_x_volts_below_full: number;
    force_let_through_to_grid_over_pv_voltage1: number;
    force_let_through_to_grid_over_pv_voltage2: number;
    peak_min_change: number;
  };
  start_bulk_charge_after_wh_discharged: number;
};
