/**
 * The HECS energy-distribution settings the controller restores after a machine model (DM) change, pure (no
 * Node built-ins: the config page shares the defaults and the labels). Confirming DM050 on 2026-11-05
 * (12:22:23Z) the inverter had reset HECS to its factory defaults: priority Battery-Load-Grid, battery
 * discharge to the loads (EDD/EDE) and to the grid (EDF/EDG) off, AC charge (EDB) on. With EDD/EDE off the
 * battery stops supplying the house, and the firmware NAKs feeding's EDF1.
 *
 * Only the fields nobody else owns are restored. AC charge (EDB) belongs to buying, battery feed to the
 * grid (EDF/EDG) to feeding; both re-assert their own target after the reset (they did that day), and a
 * restore writing them too would fight them.
 */
import type {
  EnabledOrDisabled,
  NormalEnergyDistribution,
  SolarEnergyDistributionPriority,
} from "../config/config.types.ts";
import type { DecodedFields } from "../inverterComms/pi17Protocol.types.ts";
import type { SetterQueueItem } from "../inverterComms/inverterComms.types.ts";
import { SOLAR_ENERGY_DISTRIBUTION_PRIORITY_BY_CODE } from "../inverterComms/pi17FieldTables.ts";
import type { EnergyDistributionFieldMismatch, RestorableEnergyDistributionField } from "./gridOff.types.ts";

/** What the inverter ran on until the DM050 of 2026-11-05 reset it (the DM readback log's HECS before 151) */
export const DEFAULT_NORMAL_ENERGY_DISTRIBUTION: NormalEnergyDistribution = {
  solar_energy_distribution_priority: "Load-Battery-Grid",
  solar_charge_battery: "enabled",
  feed_power_to_utility: "enabled",
  battery_discharge_to_loads_when_solar_input_normal: "enabled",
  battery_discharge_to_loads_when_solar_input_loss: "enabled",
};

/**
 * The restorable fields in restore order: the priority first, then discharge to the loads (what EDF1 needs
 * before the firmware takes it), then solar charge and feed to utility
 */
export const RESTORABLE_ENERGY_DISTRIBUTION_FIELDS: readonly RestorableEnergyDistributionField[] = [
  "solar_energy_distribution_priority",
  "battery_discharge_to_loads_when_solar_input_normal",
  "battery_discharge_to_loads_when_solar_input_loss",
  "solar_charge_battery",
  "feed_power_to_utility",
];

/** How the page and the logs name each field */
export const ENERGY_DISTRIBUTION_FIELD_LABELS: Readonly<Record<RestorableEnergyDistributionField, string>> = {
  solar_energy_distribution_priority: "Solar priority (SEP)",
  battery_discharge_to_loads_when_solar_input_normal: "Battery to loads, with PV (EDD)",
  battery_discharge_to_loads_when_solar_input_loss: "Battery to loads, without PV (EDE)",
  solar_charge_battery: "Solar charges battery (EDA)",
  feed_power_to_utility: "Feed to utility (EDC)",
};

export const SOLAR_ENERGY_DISTRIBUTION_PRIORITIES: readonly SolarEnergyDistributionPriority[] = Object.values(
  SOLAR_ENERGY_DISTRIBUTION_PRIORITY_BY_CODE
);

const ENABLED_OR_DISABLED: readonly EnabledOrDisabled[] = ["enabled", "disabled"];

type EnableDisableField = Exclude<RestorableEnergyDistributionField, "solar_energy_distribution_priority">;

const ENABLE_DISABLE_SETTER_LETTER: Readonly<Record<EnableDisableField, "A" | "C" | "D" | "E">> = {
  solar_charge_battery: "A",
  feed_power_to_utility: "C",
  battery_discharge_to_loads_when_solar_input_normal: "D",
  battery_discharge_to_loads_when_solar_input_loss: "E",
};

/** The profile's fields corrected (config.json is hand-editable), with one sentence per correction made */
export function effectiveNormalEnergyDistribution(configured: unknown): {
  profile: NormalEnergyDistribution;
  corrections: string[];
} {
  const corrections: string[] = [];
  const candidate = isRecord(configured) ? configured : {};
  if (!isRecord(configured)) {
    corrections.push(
      `grid_off.normal_energy_distribution: ${JSON.stringify(configured)} is not an object, using the defaults`
    );
  }
  const profile: NormalEnergyDistribution = { ...DEFAULT_NORMAL_ENERGY_DISTRIBUTION };
  const priority = candidate.solar_energy_distribution_priority;
  if (isSolarEnergyDistributionPriority(priority)) profile.solar_energy_distribution_priority = priority;
  else if (isRecord(configured)) {
    corrections.push(
      `grid_off.normal_energy_distribution.solar_energy_distribution_priority: ${JSON.stringify(priority)} is not one of ${SOLAR_ENERGY_DISTRIBUTION_PRIORITIES.join(", ")}, using ${DEFAULT_NORMAL_ENERGY_DISTRIBUTION.solar_energy_distribution_priority}`
    );
  }
  for (const field of Object.keys(ENABLE_DISABLE_SETTER_LETTER) as EnableDisableField[]) {
    const value = candidate[field];
    if (isEnabledOrDisabled(value)) profile[field] = value;
    else if (isRecord(configured)) {
      corrections.push(
        `grid_off.normal_energy_distribution.${field}: ${JSON.stringify(value)} is not "enabled" or "disabled", using ${DEFAULT_NORMAL_ENERGY_DISTRIBUTION[field]}`
      );
    }
  }
  return { profile, corrections };
}

/** The restorable fields of a HECS readback that differ from the profile, in restore order */
export function energyDistributionMismatches(
  profile: NormalEnergyDistribution,
  hecsFields: DecodedFields
): EnergyDistributionFieldMismatch[] {
  return RESTORABLE_ENERGY_DISTRIBUTION_FIELDS.flatMap(field => {
    const live = hecsFields[field];
    if (live === profile[field]) return [];
    return [{ field, live: live === undefined ? undefined : String(live), wanted: profile[field] }];
  });
}

/** The restorable fields of a HECS readback as a profile, or undefined unless every one decoded to a valid value */
export function energyDistributionFromHecs(
  hecsFields: DecodedFields | undefined
): NormalEnergyDistribution | undefined {
  if (!hecsFields) return undefined;
  const priority = hecsFields.solar_energy_distribution_priority;
  const solarCharge = hecsFields.solar_charge_battery;
  const feedToUtility = hecsFields.feed_power_to_utility;
  const dischargeWithSolar = hecsFields.battery_discharge_to_loads_when_solar_input_normal;
  const dischargeWithoutSolar = hecsFields.battery_discharge_to_loads_when_solar_input_loss;
  if (
    !isSolarEnergyDistributionPriority(priority) ||
    !isEnabledOrDisabled(solarCharge) ||
    !isEnabledOrDisabled(feedToUtility) ||
    !isEnabledOrDisabled(dischargeWithSolar) ||
    !isEnabledOrDisabled(dischargeWithoutSolar)
  ) {
    return undefined;
  }
  return {
    solar_energy_distribution_priority: priority,
    solar_charge_battery: solarCharge,
    feed_power_to_utility: feedToUtility,
    battery_discharge_to_loads_when_solar_input_normal: dischargeWithSolar,
    battery_discharge_to_loads_when_solar_input_loss: dischargeWithoutSolar,
  };
}

/** The setter that puts one field at the profile's value (SEPnn or EDxn), with its queue prefix */
export function restoreSetterFor(
  mismatch: EnergyDistributionFieldMismatch,
  profile: NormalEnergyDistribution
): Pick<SetterQueueItem, "command" | "replacesPrefix"> {
  if (mismatch.field === "solar_energy_distribution_priority") {
    return { command: priorityCommand(profile.solar_energy_distribution_priority), replacesPrefix: "SEP" };
  }
  const letter = ENABLE_DISABLE_SETTER_LETTER[mismatch.field];
  return {
    command: `ED${letter}${profile[mismatch.field] === "enabled" ? 1 : 0}`,
    replacesPrefix: `ED${letter}`,
  };
}

/** "Solar priority (SEP) Battery-Load-Grid → Load-Battery-Grid, …" */
export function describeMismatches(mismatches: readonly EnergyDistributionFieldMismatch[]): string {
  if (!mismatches.length) return "none";
  return mismatches
    .map(
      mismatch =>
        `${ENERGY_DISTRIBUTION_FIELD_LABELS[mismatch.field]} ${mismatch.live ?? "unread"} → ${mismatch.wanted}`
    )
    .join(", ");
}

function priorityCommand(priority: SolarEnergyDistributionPriority): `SEP0${0 | 1 | 2}` {
  if (priority === "Battery-Load-Grid") return "SEP00";
  if (priority === "Load-Battery-Grid") return "SEP01";
  return "SEP02";
}

function isSolarEnergyDistributionPriority(value: unknown): value is SolarEnergyDistributionPriority {
  return SOLAR_ENERGY_DISTRIBUTION_PRIORITIES.some(priority => priority === value);
}

function isEnabledOrDisabled(value: unknown): value is EnabledOrDisabled {
  return ENABLED_OR_DISABLED.some(option => option === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
