/**
 * Defaults and bounds of config inverter_energy_distribution, and its correction when a value is outside
 * them (config.json is hand-editable; the config page's min/max are only input hints). Pure (no Node
 * built-ins): the config page shares the bounds.
 */
import type { InverterEnergyDistributionConfig } from "../config/config.types.ts";
import { effectiveBoundedNumber, type NumberSettingBounds } from "../config/boundedNumberSetting.ts";
import {
  DEFAULT_NORMAL_HYBRID_PROFILE,
  DEFAULT_OFF_GRID_III_PROFILE,
  effectiveEnergyDistributionProfile,
} from "./energyDistributionProfile.ts";

export type EnergyDistributionSettingName = keyof Pick<InverterEnergyDistributionConfig, "p2_after_minutes">;

export type EnergyDistributionSettingBounds = NumberSettingBounds & { unit: "min" };

export const ENERGY_DISTRIBUTION_SETTING_BOUNDS = {
  // The setters commit in ~10 s; one a DM change resets again, or one the firmware refuses, is retried on the
  // next change of the DM, the working mode or HECS (the grid check after a switch takes ~60 s). Under 2 min
  // pages on a switch's ordinary retry; past an hour the battery can stand idle that long before anyone hears.
  p2_after_minutes: { defaultValue: 10, min: 2, max: 60, unit: "min" },
} as const satisfies Record<EnergyDistributionSettingName, EnergyDistributionSettingBounds>;

export const DEFAULT_INVERTER_ENERGY_DISTRIBUTION: InverterEnergyDistributionConfig = {
  normal_hybrid: { ...DEFAULT_NORMAL_HYBRID_PROFILE },
  off_grid_iii: { ...DEFAULT_OFF_GRID_III_PROFILE },
  p2_after_minutes: ENERGY_DISTRIBUTION_SETTING_BOUNDS.p2_after_minutes.defaultValue,
};

const SETTING_NAMES = Object.keys(ENERGY_DISTRIBUTION_SETTING_BOUNDS) as EnergyDistributionSettingName[];

/** Every value corrected to its bounds, with one sentence per correction made */
export function effectiveEnergyDistributionSettings(
  configured: Partial<Record<keyof InverterEnergyDistributionConfig, unknown>> | undefined
): { settings: InverterEnergyDistributionConfig; corrections: string[] } {
  const normalHybrid = effectiveEnergyDistributionProfile(
    configured?.normal_hybrid,
    DEFAULT_NORMAL_HYBRID_PROFILE,
    "inverter_energy_distribution.normal_hybrid"
  );
  const offGridIii = effectiveEnergyDistributionProfile(
    configured?.off_grid_iii,
    DEFAULT_OFF_GRID_III_PROFILE,
    "inverter_energy_distribution.off_grid_iii"
  );
  const settings: InverterEnergyDistributionConfig = {
    ...DEFAULT_INVERTER_ENERGY_DISTRIBUTION,
    normal_hybrid: normalHybrid.profile,
    off_grid_iii: offGridIii.profile,
  };
  const corrections = [...normalHybrid.corrections, ...offGridIii.corrections];
  for (const settingName of SETTING_NAMES) {
    const { value, correction } = effectiveBoundedNumber(
      ENERGY_DISTRIBUTION_SETTING_BOUNDS[settingName],
      configured?.[settingName]
    );
    settings[settingName] = value;
    if (correction) corrections.push(`inverter_energy_distribution.${settingName}: ${correction}`);
  }
  return { settings, corrections };
}
