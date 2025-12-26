export type Config = {
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
