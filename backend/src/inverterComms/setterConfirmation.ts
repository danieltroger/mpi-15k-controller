/**
 * Maps each control write to the settings-query readback that proves the inverter actually
 * applied it — pure, no I/O. Needed because a PI17 ACK is only frame-level: the inverter commits
 * setters on an internal housekeeping cycle seconds later (see schedulerCore.ts for the measured
 * numbers), so "sent and ACKed" must never be confused with "in effect".
 */
import type { DecodedFields, SettingsQueryCommandName } from "./pi17Protocol.types.ts";

export type SetterReadbackCheck = {
  query: SettingsQueryCommandName;
  /** Decoded field name (mpp-solar naming, see influxFieldName) the readback must show */
  field: string;
  expectedValue: number | string;
  /** The setter this check belongs to, for log messages */
  forCommand: string;
};

export function expectedReadbackChecksForSetter(command: string): readonly SetterReadbackCheck[] {
  const feedingGridPower = command.match(/^GPMP(0\d{5})$/);
  if (feedingGridPower) {
    return [
      {
        query: "GPMP",
        field: "maximum_feeding_grid_power",
        expectedValue: Number(feedingGridPower[1]),
        forCommand: command,
      },
    ];
  }
  const acChargeDeciamps = command.match(/^MUCHGC(\d{4})$/);
  if (acChargeDeciamps) {
    // "Max. AC charging current" decodes via influxFieldName to this dotted key — verbatim mpp-solar naming
    return [
      {
        query: "BATS",
        field: "max._ac_charging_current",
        expectedValue: Number(acChargeDeciamps[1]) / 10,
        forCommand: command,
      },
    ];
  }
  const chargeVoltages = command.match(/^MCHGV(\d{4}),(\d{4})$/);
  if (chargeVoltages) {
    return [
      {
        query: "BATS",
        field: "battery_constant_charge_voltage(c.v.)",
        expectedValue: Number(chargeVoltages[1]) / 10,
        forCommand: command,
      },
      {
        query: "BATS",
        field: "battery_floating_charge_voltage",
        expectedValue: Number(chargeVoltages[2]) / 10,
        forCommand: command,
      },
    ];
  }
  const enableDisable = command.match(/^ED([A-G])([01])$/);
  if (enableDisable) {
    const hecsFieldByLetter: Record<string, string> = {
      A: "solar_charge_battery",
      B: "ac_charge_battery",
      C: "feed_power_to_utility",
      D: "battery_discharge_to_loads_when_solar_input_normal",
      E: "battery_discharge_to_loads_when_solar_input_loss",
      F: "battery_discharge_to_feed_grid_when_solar_input_normal",
      G: "battery_discharge_to_feed_grid_when_solar_input_loss",
    };
    return [
      {
        query: "HECS",
        field: hecsFieldByLetter[enableDisable[1]!]!,
        expectedValue: enableDisable[2] === "1" ? "enabled" : "disabled",
        forCommand: command,
      },
    ];
  }
  // Setter without a known readback (none today) — the quiet gap still applies, just no convergence check
  return [];
}

/** true = readback shows the write applied; false = still the old value (or the field/query missing) */
export function checkIsSatisfied(
  check: SetterReadbackCheck,
  decodedByQuery: Partial<Record<SettingsQueryCommandName, DecodedFields>>
): boolean {
  const fields = decodedByQuery[check.query];
  if (!fields) return false; // the confirm query itself failed — treat as unconfirmed and retry
  return fields[check.field] === check.expectedValue;
}
