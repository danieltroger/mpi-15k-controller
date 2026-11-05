/**
 * The HECS energy-distribution fields the controller enforces from config, pure (no Node built-ins: the
 * config page and the System page share the labels and the defaults). Confirming DM050 on 2026-11-05
 * (12:22:23Z) the inverter had reset HECS to its factory defaults: priority Battery-Load-Grid, battery
 * discharge to the loads (EDD/EDE) and to the grid (EDF/EDG) off, AC charge (EDB) on. With EDD/EDE off the
 * battery stopped supplying the house and the firmware NAKed feeding's EDF1.
 *
 * Only the fields nobody else owns are here. AC charge (EDB) belongs to buying, battery feed to the grid
 * (EDF/EDG) to feeding: both already derive and enforce their own target reactively.
 */
import type {
  EnabledOrDisabled,
  EnergyDistributionProfile,
  SolarEnergyDistributionPriority,
  Unmanaged,
} from "../config/config.types.ts";
import type { DecodedFields, MachineModelCode } from "../inverterComms/pi17Protocol.types.ts";
import type { SetterQueueItem } from "../inverterComms/inverterComms.types.ts";
import { SOLAR_ENERGY_DISTRIBUTION_PRIORITY_BY_CODE } from "../inverterComms/pi17FieldTables.ts";
import type {
  EnergyDistributionField,
  EnergyDistributionFieldDivergence,
  EnergyDistributionProfileName,
} from "./energyDistribution.types.ts";

export const UNMANAGED: Unmanaged = "unmanaged";

/** What the inverter ran on until the DM050 of 2026-11-05 reset it */
export const DEFAULT_NORMAL_HYBRID_PROFILE: EnergyDistributionProfile = {
  solar_energy_distribution_priority: "Load-Battery-Grid",
  solar_charge_battery: "enabled",
  feed_power_to_utility: "enabled",
  battery_discharge_to_loads_when_solar_input_normal: "enabled",
  battery_discharge_to_loads_when_solar_input_loss: "enabled",
};

/**
 * Off-Grid III ran the house fine on the inverter's own values on 2026-11-05, and which writes the firmware
 * takes in 151 is unknown: nothing is enforced there unless someone opts in
 */
export const DEFAULT_OFF_GRID_III_PROFILE: EnergyDistributionProfile = {
  solar_energy_distribution_priority: UNMANAGED,
  solar_charge_battery: UNMANAGED,
  feed_power_to_utility: UNMANAGED,
  battery_discharge_to_loads_when_solar_input_normal: UNMANAGED,
  battery_discharge_to_loads_when_solar_input_loss: UNMANAGED,
};

/** Which profile the DM readback puts in force */
export const PROFILE_BY_MACHINE_MODEL: Readonly<Record<MachineModelCode, EnergyDistributionProfileName>> = {
  "050": "normal_hybrid",
  "151": "off_grid_iii",
};

/**
 * The fields in write order: the priority first, then discharge to the loads (what EDF1 needs before the
 * firmware takes it), then solar charge and feed to utility
 */
export const ENERGY_DISTRIBUTION_FIELDS: readonly EnergyDistributionField[] = [
  "solar_energy_distribution_priority",
  "battery_discharge_to_loads_when_solar_input_normal",
  "battery_discharge_to_loads_when_solar_input_loss",
  "solar_charge_battery",
  "feed_power_to_utility",
];

/** How the pages and the logs name each field */
export const ENERGY_DISTRIBUTION_FIELD_LABELS: Readonly<Record<EnergyDistributionField, string>> = {
  solar_energy_distribution_priority: "Solar priority (SEP)",
  battery_discharge_to_loads_when_solar_input_normal: "Battery to the house, with PV (EDD)",
  battery_discharge_to_loads_when_solar_input_loss: "Battery to the house, without PV (EDE)",
  solar_charge_battery: "Solar charges the battery (EDA)",
  feed_power_to_utility: "Feed to the utility (EDC)",
};

export const SOLAR_ENERGY_DISTRIBUTION_PRIORITIES: readonly SolarEnergyDistributionPriority[] = Object.values(
  SOLAR_ENERGY_DISTRIBUTION_PRIORITY_BY_CODE
);

const ENABLED_OR_DISABLED: readonly EnabledOrDisabled[] = ["enabled", "disabled"];

type FlagField = Exclude<EnergyDistributionField, "solar_energy_distribution_priority">;

const FLAG_SETTER_LETTER: Readonly<Record<FlagField, "A" | "C" | "D" | "E">> = {
  solar_charge_battery: "A",
  feed_power_to_utility: "C",
  battery_discharge_to_loads_when_solar_input_normal: "D",
  battery_discharge_to_loads_when_solar_input_loss: "E",
};

const FLAG_FIELDS = Object.keys(FLAG_SETTER_LETTER) as FlagField[];

/**
 * One profile's fields corrected (config.json is hand-editable), with one sentence per correction made;
 * `configPath` names it in those sentences
 */
export function effectiveEnergyDistributionProfile(
  configured: unknown,
  defaults: EnergyDistributionProfile,
  configPath: string
): { profile: EnergyDistributionProfile; corrections: string[] } {
  if (!isRecord(configured)) {
    return {
      profile: { ...defaults },
      corrections: [`${configPath}: ${JSON.stringify(configured)} is not an object, using the defaults`],
    };
  }
  const corrections: string[] = [];
  const profile: EnergyDistributionProfile = { ...defaults };
  const priority = configured.solar_energy_distribution_priority;
  if (priority === UNMANAGED || isSolarEnergyDistributionPriority(priority)) {
    profile.solar_energy_distribution_priority = priority;
  } else {
    corrections.push(
      `${configPath}.solar_energy_distribution_priority: ${JSON.stringify(priority)} is not one of ${[...SOLAR_ENERGY_DISTRIBUTION_PRIORITIES, UNMANAGED].join(", ")}, using ${defaults.solar_energy_distribution_priority}`
    );
  }
  for (const field of FLAG_FIELDS) {
    const value = configured[field];
    if (value === UNMANAGED || isEnabledOrDisabled(value)) profile[field] = value;
    else {
      corrections.push(
        `${configPath}.${field}: ${JSON.stringify(value)} is not "enabled", "disabled" or "unmanaged", using ${defaults[field]}`
      );
    }
  }
  return { profile, corrections };
}

/**
 * The managed fields of a HECS readback that differ from the profile, in write order. A field missing from
 * the readback is not a difference (unreadManagedFields): nothing is known about it. A value outside the
 * domain ("Unknown key: 03") is one, and is written back.
 */
export function energyDistributionDivergences(
  profile: EnergyDistributionProfile,
  hecsFields: DecodedFields
): EnergyDistributionFieldDivergence[] {
  return ENERGY_DISTRIBUTION_FIELDS.flatMap(field => {
    const desired = profile[field];
    const inverter = hecsFields[field];
    if (desired === UNMANAGED || inverter === undefined || inverter === desired) return [];
    return [{ field, inverter: String(inverter), desired }];
  });
}

/**
 * The managed fields a HECS readback lacks (an empty token): they're skipped, never written on a guess, while
 * the fields that were read are judged (energyDistributionUnreadFields.ts pages them)
 */
export function unreadManagedFields(
  profile: EnergyDistributionProfile,
  hecsFields: DecodedFields
): EnergyDistributionField[] {
  return ENERGY_DISTRIBUTION_FIELDS.filter(field => profile[field] !== UNMANAGED && hecsFields[field] === undefined);
}

/** The setter that puts one field at its desired value (SEPnn or EDxn), with its queue prefix */
export function setterForDivergence(
  divergence: EnergyDistributionFieldDivergence
): Pick<SetterQueueItem, "command" | "replacesPrefix"> {
  if (divergence.field === "solar_energy_distribution_priority") {
    return { command: priorityCommand(divergence.desired), replacesPrefix: "SEP" };
  }
  const letter = FLAG_SETTER_LETTER[divergence.field];
  return { command: `ED${letter}${divergence.desired === "enabled" ? 1 : 0}`, replacesPrefix: `ED${letter}` };
}

/** "Solar priority (SEP) Battery-Load-Grid → Load-Battery-Grid, …" */
export function describeDivergences(divergences: readonly EnergyDistributionFieldDivergence[]): string {
  if (!divergences.length) return "none";
  return divergences
    .map(
      divergence =>
        `${ENERGY_DISTRIBUTION_FIELD_LABELS[divergence.field]} ${divergence.inverter} → ${divergence.desired}`
    )
    .join(", ");
}

/** "Feed to the utility (EDC)", or "Solar priority (SEP), Feed to the utility (EDC)": for the logs, alerts and the card */
export function describeUnreadFields(unreadFields: readonly EnergyDistributionField[]): string {
  return unreadFields.map(field => ENERGY_DISTRIBUTION_FIELD_LABELS[field]).join(", ");
}

/** Only ever called with a managed field's desired value, which the config correction validated */
function priorityCommand(priority: string): `SEP0${0 | 1 | 2}` {
  if (priority === "Battery-Load-Grid") return "SEP00";
  if (priority === "Load-Battery-Grid") return "SEP01";
  if (priority === "Load-Grid-Battery") return "SEP02";
  throw new Error(`No SEP setter for the solar priority ${JSON.stringify(priority)}`);
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
