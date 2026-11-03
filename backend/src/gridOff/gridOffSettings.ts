/**
 * Bounds and defaults of the grid-off switch's knobs (config grid_off), and their correction when a value
 * is outside them (config.json is hand-editable; the config page's min/max are only input hints). Pure (no
 * Node built-ins): the config page shares the bounds.
 */
import type { GridOffConfig } from "../config/config.types.ts";
import { effectiveBoundedNumber, type NumberSettingBounds } from "../config/boundedNumberSetting.ts";

/** The numeric knobs (poll_machine_model is the one switch) */
export type GridOffSettingName = Exclude<keyof GridOffConfig, "poll_machine_model">;

export type GridOffSettingBounds = NumberSettingBounds & { unit: "%" | "min" | "s" };

export const GRID_OFF_SETTING_BOUNDS = {
  // The owner's floor for running on the battery alone. Under 5 % the Ah ledger's drift (0.9–4.2 pp a day)
  // is the whole margin; Off-Grid III's own fallback (the grid takes the house at the battery cut-off)
  // still stands behind it.
  min_soc_percent: { defaultValue: 10, min: 5, max: 80, unit: "%" },
  // Switching on needs this much above the floor, so the switch can't flap on the floor itself
  switch_on_soc_margin_percent: { defaultValue: 5, min: 1, max: 30, unit: "%" },
  // A DM write commits ~10 s after its ACK and the inverter then waits its 60 s grid check before it
  // connects, so under 3 min a window could start with the house still off the grid.
  reconnect_before_window_minutes: { defaultValue: 10, min: 3, max: 120, unit: "min" },
  // A clean stop (systemctl restart) waits at most this for the inverter to ACK DM050; the inverter commits
  // an ACKed write by itself. 0 = don't wait (the next start's fail-safe still switches back).
  shutdown_wait_seconds: { defaultValue: 5, min: 0, max: 20, unit: "s" },
  // Each switch is a relay change and a settings write: a script on the LAN ws mustn't cycle it every readback
  min_seconds_between_switches: { defaultValue: 60, min: 30, max: 3600, unit: "s" },
  // A DM050 commits ~10 s after its ACK and is resent 1, 2 and 5 min apart. Under a minute pages on a slow
  // commit; past 30 min a buy window can go by uncharged before anyone hears.
  stuck_p1_after_minutes: { defaultValue: 3, min: 1, max: 30, unit: "min" },
} as const satisfies Record<GridOffSettingName, GridOffSettingBounds>;

export const DEFAULT_GRID_OFF_SETTINGS: GridOffConfig = {
  min_soc_percent: GRID_OFF_SETTING_BOUNDS.min_soc_percent.defaultValue,
  switch_on_soc_margin_percent: GRID_OFF_SETTING_BOUNDS.switch_on_soc_margin_percent.defaultValue,
  reconnect_before_window_minutes: GRID_OFF_SETTING_BOUNDS.reconnect_before_window_minutes.defaultValue,
  shutdown_wait_seconds: GRID_OFF_SETTING_BOUNDS.shutdown_wait_seconds.defaultValue,
  min_seconds_between_switches: GRID_OFF_SETTING_BOUNDS.min_seconds_between_switches.defaultValue,
  stuck_p1_after_minutes: GRID_OFF_SETTING_BOUNDS.stuck_p1_after_minutes.defaultValue,
  poll_machine_model: true,
};

const GRID_OFF_SETTING_NAMES = Object.keys(GRID_OFF_SETTING_BOUNDS) as GridOffSettingName[];

/** Every knob corrected to its bounds, with one sentence per correction made */
export function effectiveGridOffSettings(configured: Partial<Record<keyof GridOffConfig, unknown>> | undefined): {
  settings: GridOffConfig;
  corrections: string[];
} {
  const settings: GridOffConfig = { ...DEFAULT_GRID_OFF_SETTINGS };
  const corrections: string[] = [];
  const pollMachineModel = configured?.poll_machine_model;
  if (typeof pollMachineModel === "boolean") settings.poll_machine_model = pollMachineModel;
  else {
    corrections.push(`grid_off.poll_machine_model: ${JSON.stringify(pollMachineModel)} is not true/false, using true`);
  }
  for (const settingName of GRID_OFF_SETTING_NAMES) {
    const { value, correction } = effectiveBoundedNumber(
      GRID_OFF_SETTING_BOUNDS[settingName],
      configured?.[settingName]
    );
    settings[settingName] = value;
    if (correction) corrections.push(`grid_off.${settingName}: ${correction}`);
  }
  return { settings, corrections };
}
