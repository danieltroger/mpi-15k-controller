import type { Config } from "../../../backend/src/config/config.types";

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
 * Three-way merge: apply only what the user actually changed (vs the `pristine` snapshot the form
 * was loaded from) onto the latest server config. Rows/fields the user never touched keep whatever
 * the server has now — so a schedule the auto-trader wrote while the tab was open survives a save.
 * Row identity is kind + start time: editing either counts as delete-old + add-new.
 */
export function diffMergeFormIntoConfig(pristine: BuySellFormData, values: BuySellFormData, latest: Config): Config {
  const scalar = (before: number, now: number, latestVal: number): number =>
    Number(now) !== Number(before) ? Number(now) : latestVal;

  const mergeSchedule = <E extends { end_time: string }>(
    kind: ScheduleRowKind,
    latestSchedule: Record<string, E>,
    toEntry: (row: BuySellScheduleRow) => E
  ): Record<string, E> => {
    const ofKind = (rows: BuySellScheduleRow[]) => filterCompleteRows(rows).filter(r => r.kind === kind);
    const result: Record<string, E> = { ...latestSchedule };
    const pristineByKey = new Map(ofKind(pristine.rows).map(r => [datetimeLocalToIso(r.start), r]));
    const currentByKey = new Map(ofKind(values.rows).map(r => [datetimeLocalToIso(r.start), r]));
    for (const key of pristineByKey.keys()) {
      if (!currentByKey.has(key)) delete result[key]; // the user removed this row
    }
    for (const [key, row] of currentByKey) {
      const before = pristineByKey.get(key);
      const changed = !before || before.end !== row.end || Number(before.power) !== Number(row.power);
      if (changed) result[key] = toEntry(row); // the user added or edited this row
    }
    return result;
  };

  return {
    ...latest,
    automatic_trading: {
      ...latest.automatic_trading,
      emergency_soc_floor_percent: scalar(
        pristine.emergencySocFloor,
        values.emergencySocFloor,
        latest.automatic_trading.emergency_soc_floor_percent
      ),
      planner_soc_floor_percent: scalar(
        pristine.plannerSocFloor,
        values.plannerSocFloor,
        latest.automatic_trading.planner_soc_floor_percent
      ),
      planner_soc_floor_sunny_percent: scalar(
        pristine.plannerSocFloorSunny,
        values.plannerSocFloorSunny,
        latest.automatic_trading.planner_soc_floor_sunny_percent
      ),
      extra_reserve_kwh: scalar(
        pristine.extraReserveKwh,
        values.extraReserveKwh,
        latest.automatic_trading.extra_reserve_kwh
      ),
    },
    scheduled_power_buying: {
      only_buy_below_soc: scalar(
        pristine.buyOnlyBelowSoc,
        values.buyOnlyBelowSoc,
        latest.scheduled_power_buying.only_buy_below_soc
      ),
      start_buying_again_below_soc: scalar(
        pristine.buyStartAgainBelowSoc,
        values.buyStartAgainBelowSoc,
        latest.scheduled_power_buying.start_buying_again_below_soc
      ),
      max_grid_input_amperage: scalar(
        pristine.maxGridInputAmperage,
        values.maxGridInputAmperage,
        latest.scheduled_power_buying.max_grid_input_amperage
      ),
      schedule: mergeSchedule("buy", latest.scheduled_power_buying.schedule, row => ({
        end_time: datetimeLocalToIso(row.end),
        charging_power: Number(row.power),
      })),
    },
    scheduled_power_selling: {
      only_sell_above_soc: scalar(
        pristine.sellOnlyAboveSoc,
        values.sellOnlyAboveSoc,
        latest.scheduled_power_selling.only_sell_above_soc
      ),
      start_selling_again_above_soc: scalar(
        pristine.sellStartAgainAboveSoc,
        values.sellStartAgainAboveSoc,
        latest.scheduled_power_selling.start_selling_again_above_soc
      ),
      only_sell_above_voltage: scalar(
        pristine.onlySellAboveVoltage,
        values.onlySellAboveVoltage,
        latest.scheduled_power_selling.only_sell_above_voltage
      ),
      start_selling_again_above_voltage: scalar(
        pristine.startSellingAgainAboveVoltage,
        values.startSellingAgainAboveVoltage,
        latest.scheduled_power_selling.start_selling_again_above_voltage
      ),
      schedule: mergeSchedule("sell", latest.scheduled_power_selling.schedule, row => ({
        end_time: datetimeLocalToIso(row.end),
        power_watts: Number(row.power),
      })),
    },
  };
}
