import type { Config } from "../../../backend/src/config/config.types";

export type BuySellScheduleRow = {
  start: string;
  end: string;
  power: number;
};

export type BuySellFormData = {
  buyOnlyBelowSoc: number;
  buyStartAgainBelowSoc: number;
  maxGridInputAmperage: number;
  sellOnlyAboveSoc: number;
  sellStartAgainAboveSoc: number;
  onlySellAboveVoltage: number;
  startSellingAgainAboveVoltage: number;
  buyingRows: BuySellScheduleRow[];
  sellingRows: BuySellScheduleRow[];
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

function scheduleToBuyingRows(schedule: Config["scheduled_power_buying"]["schedule"]): BuySellScheduleRow[] {
  return Object.entries(schedule).map(([start, v]) => ({
    start: isoToDatetimeLocal(start),
    end: isoToDatetimeLocal(v.end_time),
    power: v.charging_power,
  }));
}

function scheduleToSellingRows(schedule: Config["scheduled_power_selling"]["schedule"]): BuySellScheduleRow[] {
  return Object.entries(schedule).map(([start, v]) => ({
    start: isoToDatetimeLocal(start),
    end: isoToDatetimeLocal(v.end_time),
    power: v.power_watts,
  }));
}

export function configToBuySellFormData(c: Config): BuySellFormData {
  return {
    buyOnlyBelowSoc: c.scheduled_power_buying.only_buy_below_soc,
    buyStartAgainBelowSoc: c.scheduled_power_buying.start_buying_again_below_soc,
    maxGridInputAmperage: c.scheduled_power_buying.max_grid_input_amperage,
    sellOnlyAboveSoc: c.scheduled_power_selling.only_sell_above_soc,
    sellStartAgainAboveSoc: c.scheduled_power_selling.start_selling_again_above_soc,
    onlySellAboveVoltage: c.scheduled_power_selling.only_sell_above_voltage,
    startSellingAgainAboveVoltage: c.scheduled_power_selling.start_selling_again_above_voltage,
    buyingRows: scheduleToBuyingRows(c.scheduled_power_buying.schedule),
    sellingRows: scheduleToSellingRows(c.scheduled_power_selling.schedule),
  };
}

/** Rows with both start and end filled; used when persisting. */
export function filterCompleteRows(rows: BuySellScheduleRow[]): BuySellScheduleRow[] {
  return rows.filter(r => r.start.trim() !== "" && r.end.trim() !== "");
}

export function formValuesToConfig(values: BuySellFormData, base: Config): Config {
  const buyingRows = filterCompleteRows(values.buyingRows);
  const sellingRows = filterCompleteRows(values.sellingRows);

  const buyingSchedule: Config["scheduled_power_buying"]["schedule"] = {};
  for (const row of buyingRows) {
    buyingSchedule[datetimeLocalToIso(row.start)] = {
      end_time: datetimeLocalToIso(row.end),
      charging_power: row.power,
    };
  }

  const sellingSchedule: Config["scheduled_power_selling"]["schedule"] = {};
  for (const row of sellingRows) {
    sellingSchedule[datetimeLocalToIso(row.start)] = {
      end_time: datetimeLocalToIso(row.end),
      power_watts: row.power,
    };
  }

  return {
    ...base,
    scheduled_power_buying: {
      only_buy_below_soc: values.buyOnlyBelowSoc,
      start_buying_again_below_soc: values.buyStartAgainBelowSoc,
      max_grid_input_amperage: values.maxGridInputAmperage,
      schedule: buyingSchedule,
    },
    scheduled_power_selling: {
      only_sell_above_soc: values.sellOnlyAboveSoc,
      start_selling_again_above_soc: values.sellStartAgainAboveSoc,
      only_sell_above_voltage: values.onlySellAboveVoltage,
      start_selling_again_above_voltage: values.startSellingAgainAboveVoltage,
      schedule: sellingSchedule,
    },
  };
}
