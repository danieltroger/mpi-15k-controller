import { promises as fs_promises } from "fs";
import { batch, createEffect, createSignal, Owner, runWithOwner, Signal, untrack } from "solid-js";
import path from "path";
import process from "process";
import { error, log } from "./utilities/logging";

export type Config = {
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
  };
  scheduled_power_buying: {
    schedule: Record<
      string,
      {
        end_time: string;
        charging_amperage: number;
      }
    >;
    only_buy_below_soc: number;
    start_buying_again_below_soc: number;
    enable_subtracting_consumption_above_charging_amperage: number;
  };
  influxdb?: {
    host: string;
    database: string;
    username: string;
    password: string;
  };
  soc_calculations: {
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

const default_config: Config = {
  scheduled_power_selling: {
    schedule: {
      "2024-08-25T22:00:00+02:00": { "end_time": "2024-08-25T22:02:00+02:00", power_watts: 1500 },
    },
    only_sell_above_soc: 13,
    start_selling_again_above_soc: 25,
  },
  scheduled_power_buying: {
    schedule: {
      "2024-08-25T22:00:00+02:00": { "end_time": "2024-08-25T22:02:00+02:00", charging_amperage: 200 },
    },
    only_buy_below_soc: 40,
    start_buying_again_below_soc: 15,
    enable_subtracting_consumption_above_charging_amperage: 150,
  },
  elpatron_switching: {
    enabled: false,
    min_solar_input: 6000,
  },
  soc_calculations: {
    battery_empty_at: 46,
    capacity_per_cell_from_wh: 18,
    capacity_per_cell_to_wh: 20,
    parasitic_consumption_from: 200,
    parasitic_consumption_to: 350,
    number_of_cells: 576,
    table: "soc_values",
    current_state: {
      capacity: 19.2 * 12 * 3 * 16,
      parasitic_consumption: 315,
    },
  },
  float_charging_voltage: 53.5,
  full_battery_voltage: 58.4,
  start_bulk_charge_voltage: 46,
  start_bulk_charge_after_wh_discharged: 1500,
  shinemonitor_company_key: "bnrl_frRFjEz8Mkn",
  mqtt_host: "192.168.0.3",
  stop_charging_below_current: 10,
  thermometers: {},
  temperature_report_interval: 3000,
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

export async function get_config_object(owner: Owner) {
  log("Getting config object");
  let config_writing_debounce: ReturnType<typeof setTimeout> | undefined;
  let current_config_file_value: string | undefined;

  const config_file_name = path.dirname(process.argv[1]) + "/../config.json";
  log("Using", config_file_name, "as config file");

  let existing_config: Partial<Config> = {};
  if (!(await fs_promises.access(config_file_name, 0 /* 0 is F_OK */).catch(() => true))) {
    try {
      existing_config = JSON.parse(
        (current_config_file_value = await fs_promises.readFile(config_file_name, { encoding: "utf-8" }))
      );
    } catch (e) {
      log("Error parsing config file", e, "ignoring it");
      existing_config = {};
    }
  }
  const initial_config = { ...default_config, ...existing_config } as const;
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
            error("Error writing config", e);
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
        batch(() => set_actual_config({ ...default_config, ...new_value }));
      };
      if (typeof new_value_or_setter === "function") {
        set(new_value_or_setter(untrack(get_config)));
      } else {
        set(new_value_or_setter);
      }
    },
  ] as Signal<Config>;
}
