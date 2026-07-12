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
  /** The inverter ramps grid feed-in from 0 to full power over ~this many minutes (grid safety) */
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
  /** Locally calibrated PV model: watts produced per W/m² of open-meteo radiation */
  solar_model: {
    watts_per_direct_radiation: number;
    watts_per_diffuse_radiation: number;
    /** Re-fit the coefficients against actual production every N days (0 = never) */
    refit_interval_days: number;
    last_fitted_at?: string;
    fit_r2?: number;
    fit_samples?: number;
  };
};

export type Config = {
  automatic_trading: AutomaticTradingConfig;
  usb_parameter_setting: {
    min_seconds_between_commands: number;
    /**
     * We'll check all values after setting them, but apart from that we also poll sometimes.
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
    recalculate_parameters_interval_seconds: number;
    battery_empty_at: number;
    capacity_per_cell_from_wh: number;
    capacity_per_cell_to_wh: number;
    parasitic_consumption_from: number;
    parasitic_consumption_to: number;
    number_of_cells: number;
    table: string;
    current_state: {
      parasitic_consumption: number;
      capacity: number;
    };
    /**
     * Coulomb-counting (Ah) SOC ledger — the Phase 1 shadow of the Wh system above. Anchored at the
     * latest full/empty/soft-empty event and integrated from hall sensor 2 amps:
     *   SOC = anchor_soc + (∫amps·dt − drain_a·elapsed_h) / capacity_ah · 100
     * `drain_a` (sensor zero-bias + parasitic, seasonal) and `capacity_ah` are tracked online (EMA)
     * and persisted here across restarts, exactly like `current_state` above.
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
  temperature_report_interval: number;
  thermometers: { [key: string]: string };
  mqtt_host: string;
  temperature_saving: {
    database: string;
    table: string;
  };
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
  shinemonitor_password?: string;
  shinemonitor_user?: string;
  shinemonitor_company_key: string;
  inverter_sn?: string;
  inverter_pn?: string;
  savedAuth_do_not_edit?: {
    createdAt: number;
    authApiReturn: {
      err: number;
      desc: string;
      dat: {
        secret: string;
        expire: number;
        token: string;
        role: number;
        usr: string;
        uid: number;
      };
    };
  };
};
