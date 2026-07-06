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
  };
  elpatron_switching: {
    enabled: boolean;
    min_solar_input: number;
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
