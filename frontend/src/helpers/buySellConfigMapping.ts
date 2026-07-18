import { configSet, configUnset } from "~/helpers/configPatches";
import type { Config } from "../../../backend/src/config/config.types";
import type { ConfigPatch } from "../../../backend/src/wsContract.types";

export type ScheduleRowKind = "sell" | "buy";

export type BuySellScheduleRow = {
  kind: ScheduleRowKind;
  start: string;
  end: string;
  power: number;
};

export type BuySellFormData = {
  // Battery reserve & floors (automatic_trading)
  emergencySocFloor: number;
  plannerSocFloor: number;
  plannerSocFloorSunny: number;
  extraReserveKwh: number;
  // Runtime guards
  buyOnlyBelowSoc: number;
  buyStartAgainBelowSoc: number;
  maxGridInputAmperage: number;
  sellOnlyAboveSoc: number;
  sellStartAgainAboveSoc: number;
  onlySellAboveVoltage: number;
  startSellingAgainAboveVoltage: number;
  /** One chronological list; kind decides which config schedule a row lands in */
  rows: BuySellScheduleRow[];
};

/** Display ISO datetimes in `datetime-local` format (local wall time). */
export function isoToDatetimeLocal(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(+d)) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Convert `datetime-local` value to UTC ISO string for storage (same instant as the picker). */
export function datetimeLocalToIso(local: string): string {
  const d = new Date(local);
  return d.toISOString();
}

export function configToBuySellFormData(c: Config): BuySellFormData {
  const rows: BuySellScheduleRow[] = [
    ...Object.entries(c.scheduled_power_selling.schedule).map(([start, v]) => ({
      kind: "sell" as const,
      start: isoToDatetimeLocal(start),
      end: isoToDatetimeLocal(v.end_time),
      power: v.power_watts,
    })),
    ...Object.entries(c.scheduled_power_buying.schedule).map(([start, v]) => ({
      kind: "buy" as const,
      start: isoToDatetimeLocal(start),
      end: isoToDatetimeLocal(v.end_time),
      power: v.charging_power,
    })),
  ].sort((a, b) => a.start.localeCompare(b.start));
  return {
    emergencySocFloor: c.automatic_trading.emergency_soc_floor_percent,
    plannerSocFloor: c.automatic_trading.planner_soc_floor_percent,
    plannerSocFloorSunny: c.automatic_trading.planner_soc_floor_sunny_percent,
    extraReserveKwh: c.automatic_trading.extra_reserve_kwh,
    buyOnlyBelowSoc: c.scheduled_power_buying.only_buy_below_soc,
    buyStartAgainBelowSoc: c.scheduled_power_buying.start_buying_again_below_soc,
    maxGridInputAmperage: c.scheduled_power_buying.max_grid_input_amperage,
    sellOnlyAboveSoc: c.scheduled_power_selling.only_sell_above_soc,
    sellStartAgainAboveSoc: c.scheduled_power_selling.start_selling_again_above_soc,
    onlySellAboveVoltage: c.scheduled_power_selling.only_sell_above_voltage,
    startSellingAgainAboveVoltage: c.scheduled_power_selling.start_selling_again_above_voltage,
    rows,
  };
}

/** Rows with both start and end filled; used when persisting. */
export function filterCompleteRows(rows: BuySellScheduleRow[]): BuySellScheduleRow[] {
  return rows.filter(r => r.start.trim() !== "" && r.end.trim() !== "");
}

/**
 * Diff the form against the `pristine` snapshot it was loaded from and emit one patch per field
 * the user actually changed — untouched fields/rows are never sent, so anything the backend wrote
 * while the tab was open (e.g. auto-trader schedule windows) survives a save by construction.
 * Row identity is kind + start time: editing either counts as delete-old + add-new. Set patches
 * come before unset patches so a failure mid-batch can leave a duplicate row but never a hole.
 */
export function diffFormIntoPatches(pristine: BuySellFormData, values: BuySellFormData): ConfigPatch[] {
  const sets: ConfigPatch[] = [];
  const unsets: ConfigPatch[] = [];
  const scalar = (before: number, now: number, makePatch: (value: number) => ConfigPatch) => {
    if (Number(now) !== Number(before)) sets.push(makePatch(Number(now)));
  };

  scalar(pristine.emergencySocFloor, values.emergencySocFloor, value =>
    configSet(["automatic_trading", "emergency_soc_floor_percent"], value)
  );
  scalar(pristine.plannerSocFloor, values.plannerSocFloor, value =>
    configSet(["automatic_trading", "planner_soc_floor_percent"], value)
  );
  scalar(pristine.plannerSocFloorSunny, values.plannerSocFloorSunny, value =>
    configSet(["automatic_trading", "planner_soc_floor_sunny_percent"], value)
  );
  scalar(pristine.extraReserveKwh, values.extraReserveKwh, value =>
    configSet(["automatic_trading", "extra_reserve_kwh"], value)
  );
  scalar(pristine.buyOnlyBelowSoc, values.buyOnlyBelowSoc, value =>
    configSet(["scheduled_power_buying", "only_buy_below_soc"], value)
  );
  scalar(pristine.buyStartAgainBelowSoc, values.buyStartAgainBelowSoc, value =>
    configSet(["scheduled_power_buying", "start_buying_again_below_soc"], value)
  );
  scalar(pristine.maxGridInputAmperage, values.maxGridInputAmperage, value =>
    configSet(["scheduled_power_buying", "max_grid_input_amperage"], value)
  );
  scalar(pristine.sellOnlyAboveSoc, values.sellOnlyAboveSoc, value =>
    configSet(["scheduled_power_selling", "only_sell_above_soc"], value)
  );
  scalar(pristine.sellStartAgainAboveSoc, values.sellStartAgainAboveSoc, value =>
    configSet(["scheduled_power_selling", "start_selling_again_above_soc"], value)
  );
  scalar(pristine.onlySellAboveVoltage, values.onlySellAboveVoltage, value =>
    configSet(["scheduled_power_selling", "only_sell_above_voltage"], value)
  );
  scalar(pristine.startSellingAgainAboveVoltage, values.startSellingAgainAboveVoltage, value =>
    configSet(["scheduled_power_selling", "start_selling_again_above_voltage"], value)
  );

  diffScheduleOfKind("sell", pristine.rows, values.rows, sets, unsets);
  diffScheduleOfKind("buy", pristine.rows, values.rows, sets, unsets);
  return [...sets, ...unsets];
}

function diffScheduleOfKind(
  kind: ScheduleRowKind,
  pristineRows: BuySellScheduleRow[],
  currentRows: BuySellScheduleRow[],
  sets: ConfigPatch[],
  unsets: ConfigPatch[]
) {
  const section = kind === "sell" ? ("scheduled_power_selling" as const) : ("scheduled_power_buying" as const);
  const ofKind = (rows: BuySellScheduleRow[]) => filterCompleteRows(rows).filter(r => r.kind === kind);
  const pristineByKey = new Map(ofKind(pristineRows).map(r => [datetimeLocalToIso(r.start), r]));
  const currentByKey = new Map(ofKind(currentRows).map(r => [datetimeLocalToIso(r.start), r]));
  for (const [key, row] of currentByKey) {
    const before = pristineByKey.get(key);
    const changed = !before || before.end !== row.end || Number(before.power) !== Number(row.power);
    if (!changed) continue; // untouched rows are never sent
    // …only rows the user added or edited become set patches
    if (kind === "sell") {
      sets.push(
        configSet(["scheduled_power_selling", "schedule", key], {
          end_time: datetimeLocalToIso(row.end),
          power_watts: Number(row.power),
        })
      );
    } else {
      sets.push(
        configSet(["scheduled_power_buying", "schedule", key], {
          end_time: datetimeLocalToIso(row.end),
          charging_power: Number(row.power),
        })
      );
    }
  }
  for (const key of pristineByKey.keys()) {
    if (!currentByKey.has(key)) unsets.push(configUnset([section, "schedule", key])); // the user removed this row
  }
}
