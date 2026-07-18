import { promises as fs_promises } from "fs";
import { batch, createEffect, createSignal, type Owner, runWithOwner, type Signal, untrack } from "solid-js";
import path from "path";
import process from "process";
import { errorLog, logLog } from "../utilities/logging.ts";
import type { Config } from "./config.types.ts";

// The MPI 15K produces at most 15 kW of AC (house + grid export share it, house first) — the
// sell setpoint, buy charging power and the planner's AC envelope all default to this nameplate.
const INVERTER_NAMEPLATE_AC_WATTS = 15000;

export const default_config: Config = {
  alerting: {
    enabled: true,
    dry_run: true,
    pushover_app_token: "",
    pushover_recipient_key: "",
    site_name: "",
    battery_temp_p1_celsius: 45,
    inverter_temp_p1_celsius: 97,
    cooling_outlet_temp_p2_celsius: 36,
    battery_undervoltage_p2_volts: 46,
    battery_overvoltage_p1_volts: 58.8,
    charging_battery_temp_p1_celsius: 1,
    stale_mqtt_p2_minutes: 5,
    stale_temperatures_p2_minutes: 10,
    grid_out_below_volts: 100,
    grid_out_p2_seconds: 60,
    error_log_p2: true,
    digest_p3: true,
    cooldown_minutes: 30,
    max_pushes_per_hour: 20,
    max_errorlog_pushes_per_hour: 6,
    startup_grace_seconds: 180,
  },
  automatic_trading: {
    enabled: false,
    price_area: "SE3",
    plan_at_local_time: "13:10",
    // Generic Sweden coordinates — set your real ones in config.json
    latitude: 59.33,
    longitude: 18.07,
    max_sell_power_watts: INVERTER_NAMEPLATE_AC_WATTS,
    inverter_max_ac_output_watts: INVERTER_NAMEPLATE_AC_WATTS,
    max_buy_power_watts: INVERTER_NAMEPLATE_AC_WATTS,
    planner_soc_floor_percent: 10,
    planner_soc_floor_sunny_percent: 5,
    emergency_soc_floor_percent: 3,
    extra_reserve_kwh: 0,
    min_sell_spot_sek_per_kwh: 0.08,
    min_gain_sek_per_slot: 0.05,
    min_buy_saving_sek_per_kwh: 0.25,
    allow_arbitrage_buying: true,
    sell_ramp_minutes: 10,
    min_window_minutes: 15,
    charge_efficiency: 0.95,
    discharge_efficiency: 0.93,
    // E.ON 2026: elöverföring 0.734 + energiskatt 0.36 + rörliga kostnader ~0.052 + fast påslag 0.04
    buy_surcharges_sek_per_kwh: 1.186,
    vat_multiplier: 1.25,
    // spotpris påslag 0.02 + nätnytta 0.072
    sell_bonus_sek_per_kwh: 0.092,
    constraint_tail_hours: 18,
    // One tick per price slot; a healthy tick is cheap (forecasts/prices are cached, only the
    // breach projection runs) and a breach gets caught one slot sooner
    guard_interval_minutes: 15,
    opportunistic_replan_interval_minutes: 60,
    opportunistic_replan_min_gain_sek: 5,
    replan_retry_minutes: 15,
    fallback_house_load_watts: 550,
    // Least-squares fit of inverter PV production vs open-meteo direct/diffuse radiation (June 2026).
    // Sun angles shift over the year — worth re-fitting seasonally (see planPreview/backtest tooling).
    solar_model: {
      watts_per_direct_radiation: 9.95,
      watts_per_diffuse_radiation: 16.4,
      refit_interval_days: 14,
    },
  },
  usb_parameter_setting: { min_seconds_between_commands: 60, poll_values_interval_seconds: 60 * 5 },
  scheduled_power_selling: {
    schedule: {
      "2024-08-25T22:00:00+02:00": { "end_time": "2024-08-25T22:02:00+02:00", power_watts: 1500 },
    },
    only_sell_above_soc: 13,
    start_selling_again_above_soc: 25,
    only_sell_above_voltage: 49.8,
    start_selling_again_above_voltage: 52.2,
  },
  scheduled_power_buying: {
    schedule: {
      "2024-08-25T22:00:00+02:00": { "end_time": "2024-08-25T22:02:00+02:00", charging_power: 9000 },
    },
    only_buy_below_soc: 40,
    start_buying_again_below_soc: 15,
    max_grid_input_amperage: 21,
  },
  elpatron_switching: {
    enabled: false,
    min_solar_input: 6000,
    heating_pi_ip: "192.168.1.100",
    element_watts: 6200,
    tank_wh_per_degree: 480,
    tank_cooling_degrees_per_hour: 1,
    tank_max_temperature: 50,
  },
  soc_calculations: {
    battery_empty_at: 46,
    table: "soc_values",
    // Validated offline on 3 months of hall-sensor-2 data (Phase 0). drain_a is seasonal (~0.7 A in
    // spring, ~2.8 A in summer) which is why it is tracked online rather than hard-coded.
    ah_ledger: {
      capacity_ah: 1240,
      drain_a: 2.8,
      v_discharge: 51.63,
      v_charge: 53.79,
      drain_ema_tau_days: 7,
      soft_empty: {
        voltage: 49,
        max_abs_amps: 30,
        soc_percent: 0.4,
      },
    },
  },
  current_measuring: {
    table: "current_values",
    rate_constant: 0,
    enabled: true,
    average_over_time_ms: 1000,
    millivolts_per_ampere: 2.5,
    zero_current_millivolts: 2500,
    zero_current_millivolts2: 2500,
    millivolts_per_ampere2: 2.5,
  },
  float_charging_voltage: 53.5,
  full_battery_voltage: 58.4,
  start_bulk_charge_voltage: 46,
  start_bulk_charge_after_wh_discharged: 1500,
  mqtt_host: "192.168.0.3",
  stop_charging_below_current: 10,
  thermometers: {},
  temperature_saving: {
    database: "mppsolar",
    table: "battery_temperatures",
  },
  feed_from_battery_when_no_solar: {
    feed_amount_watts: 290,
    feed_below_available_power: 290,
    max_feed_in_power_when_feeding_from_solar: 15000,
    add_to_feed_below_when_currently_feeding: 200,
    disable_below_battery_voltage: 45,
    should_feed_debounce_time: 60_000,
    allow_switching_to_solar_feeding_during_charging_x_volts_below_full: 1.4,
    force_let_through_to_grid_over_pv_voltage1: 545,
    force_let_through_to_grid_over_pv_voltage2: 670,
    increment_with_on_peak: 1000,
    peak_increment_duration: 90,
    peak_min_change: 1000,
  },
};

/**
 * Top-level keys merge shallowly, but alerting, automatic_trading, elpatron_switching and soc_calculations
 * merge one level deeper: knobs get added over time, and a config.json written before a knob
 * existed must still pick up its default (the planner, the elpatron load model and the SOC ledger
 * do raw arithmetic on these — a missing knob would silently NaN every projection;
 * a missing alerting threshold would silently never alert).
 * soc_calculations.ah_ledger (and its soft_empty) is the newest such section, so a config
 * predating it still boots with the validated defaults. Orphaned keys from the deleted Wh fitter
 * (the fitter's persisted capacity/parasitic state and its search-range knobs) are harmless — the
 * spreads copy unknown keys straight through and nothing reads them.
 */
function mergeWithDefaults(partial: Partial<Config>): Config {
  return {
    ...default_config,
    ...partial,
    alerting: { ...default_config.alerting, ...partial.alerting },
    automatic_trading: { ...default_config.automatic_trading, ...partial.automatic_trading },
    elpatron_switching: { ...default_config.elpatron_switching, ...partial.elpatron_switching },
    soc_calculations: {
      ...default_config.soc_calculations,
      ...partial.soc_calculations,
      ah_ledger: {
        ...default_config.soc_calculations.ah_ledger,
        ...partial.soc_calculations?.ah_ledger,
        soft_empty: {
          ...default_config.soc_calculations.ah_ledger.soft_empty,
          ...partial.soc_calculations?.ah_ledger?.soft_empty,
        },
      },
    },
  };
}

export async function get_config_object(owner: Owner) {
  logLog("Getting config object");
  let config_writing_debounce: ReturnType<typeof setTimeout> | undefined;
  let current_config_file_value: string | undefined;

  const config_file_name = path.dirname(process.argv[1]) + "/../config.json";
  logLog("Using", config_file_name, "as config file");

  let existing_config: Partial<Config> = {};
  if (!(await fs_promises.access(config_file_name, 0 /* 0 is F_OK */).catch(() => true))) {
    try {
      existing_config = JSON.parse(
        (current_config_file_value = await fs_promises.readFile(config_file_name, { encoding: "utf-8" }))
      );
    } catch (e) {
      logLog("Error parsing config file", e, "ignoring it");
      existing_config = {};
    }
  }
  const initial_config = mergeWithDefaults(existing_config);
  const config_signal = createSignal<Config>(initial_config);
  const [get_config, set_actual_config] = config_signal;

  runWithOwner(owner, () =>
    createEffect(() => {
      // We could use records and tuples here in the future
      const new_config = JSON.stringify(get_config(), null, 2);
      if (current_config_file_value !== new_config) {
        clearTimeout(config_writing_debounce);
        setTimeout(async () => {
          try {
            const backup_file_name = `${path.dirname(process.argv[1])}/../config_pre_${new Date().toISOString()}.backup.json`;
            await Promise.all([
              current_config_file_value &&
                fs_promises.writeFile(backup_file_name, current_config_file_value, { encoding: "utf-8" }),
              fs_promises.writeFile(config_file_name, new_config, { encoding: "utf-8" }),
            ]);
            current_config_file_value = new_config;
          } catch (e) {
            errorLog("Error writing config", e);
          }
        }, 300);
      }
    })
  );

  return [
    get_config,
    (new_value_or_setter: Config | ((prev: Config) => Config)) => {
      const set = (new_value: Config) => {
        // So that users can't accidentally delete keys
        // Use batch so that if two values update we don't run effects for both updates
        batch(() => set_actual_config(mergeWithDefaults(new_value)));
      };
      if (typeof new_value_or_setter === "function") {
        set(new_value_or_setter(untrack(get_config)));
      } else {
        set(new_value_or_setter);
      }
    },
  ] as Signal<Config>;
}
