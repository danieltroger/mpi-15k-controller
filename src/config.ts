import { promises as fs_promises } from "fs";
import { createSignal, Owner, untrack, Signal, createEffect, runWithOwner } from "solid-js";
import path from "path";
import process from "process";
import { error, log } from "./logging";

export type Config = {
  full_battery_voltage: number;
  float_charging_voltage: number;
  start_bulk_charge_voltage: number;
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
  float_charging_voltage: 53,
  full_battery_voltage: 58.4,
  start_bulk_charge_voltage: 48,
  start_bulk_charge_after_wh_discharged: 1000,
  shinemonitor_company_key: "bnrl_frRFjEz8Mkn",
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
      const new_config = JSON.stringify(get_config());
      if (current_config_file_value !== new_config) {
        clearTimeout(config_writing_debounce);
        setTimeout(async () => {
          try {
            await fs_promises.writeFile(config_file_name, new_config, { encoding: "utf-8" });
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
        set_actual_config({ ...default_config, ...new_value }); // So that users can't accidentally delete keys
      };
      if (typeof new_value_or_setter === "function") {
        set(new_value_or_setter(untrack(get_config)));
      } else {
        set(new_value_or_setter);
      }
    },
  ] as Signal<Config>;
}