import type Influx from "influx";
import { errorLog, logLog } from "../utilities/logging.ts";
import { SLOT_MS, type PlannerKnobs } from "./planner.ts";
import type { DayForecast } from "./autoTraderState.ts";

/**
 * Closes the feedback loop: after a day has fully settled, measure what actually happened at the
 * grid meter and write it next to what the planner had predicted, so forecast bias and realized
 * P&L become queryable in Grafana (InfluxDB measurement `trading_performance`) instead of vanishing
 * into projections nobody checks. Only runs on days after the 2026-07-03 pi17 fix, since earlier
 * `ac_input_total_active_power` is firmware-corrupted (see the pi17 protocol patch).
 */

export type RealizedDay = {
  date: string;
  export_kwh: number;
  import_kwh: number;
  realized_revenue_sek: number;
  pv_kwh: number;
  house_kwh: number;
};

type FeeKnobs = Pick<PlannerKnobs, "sell_bonus_sek_per_kwh" | "buy_surcharges_sek_per_kwh" | "vat_multiplier">;

/**
 * Net grid revenue from per-slot realized grid power + that slot's spot price. Pure — same fee
 * accounting as the planner's `simulate`, so realized and projected numbers are comparable.
 * `gridW` follows the inverter convention: negative = exporting to grid, positive = importing.
 */
export function computeRealizedRevenue(
  slots: { gridW: number; spot: number }[],
  slotDurationHours: number,
  fees: FeeKnobs
): { export_kwh: number; import_kwh: number; revenue_sek: number } {
  let exportKwh = 0;
  let importKwh = 0;
  let revenueSek = 0;
  for (const { gridW, spot } of slots) {
    const slotExportKwh = (Math.max(0, -gridW) * slotDurationHours) / 1000;
    const slotImportKwh = (Math.max(0, gridW) * slotDurationHours) / 1000;
    exportKwh += slotExportKwh;
    importKwh += slotImportKwh;
    revenueSek +=
      slotExportKwh * (spot + fees.sell_bonus_sek_per_kwh) -
      slotImportKwh * (spot + fees.buy_surcharges_sek_per_kwh) * fees.vat_multiplier;
  }
  return {
    export_kwh: round1(exportKwh),
    import_kwh: round1(importKwh),
    revenue_sek: Math.round(revenueSek * 10) / 10,
  };
}

/** Fetch one past day's 15-min spot prices directly (elprisetjustnu serves historical dates). */
async function fetchPricesForDate(area: string, dateStr: string): Promise<{ startMs: number; spot: number }[]> {
  const [year, month, day] = dateStr.split("-");
  const url = `https://www.elprisetjustnu.se/api/v1/prices/${year}/${month}-${day}_${area}.json`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "mpi-15k-controller/1.0" },
      signal: controller.signal,
    });
    if (!response.ok) return [];
    const entries = (await response.json()) as { SEK_per_kWh: number; time_start: string; time_end: string }[];
    const slots: { startMs: number; spot: number }[] = [];
    for (const entry of entries) {
      const startMs = +new Date(entry.time_start);
      const endMs = +new Date(entry.time_end);
      if (!isFinite(startMs) || !isFinite(endMs)) continue;
      for (let t = startMs; t < endMs; t += SLOT_MS) slots.push({ startMs: t, spot: entry.SEK_per_kWh });
    }
    return slots.sort((a, b) => a.startMs - b.startMs);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Measure one settled local day and write a `trading_performance` point to InfluxDB. Returns the
 * realized figures (or null if data is missing) — never throws; failures log and are skipped.
 */
export async function settleTradingDay(
  influxClient: Influx.InfluxDB,
  dateStr: string,
  priceArea: string,
  fees: FeeKnobs,
  forecast: DayForecast | undefined
): Promise<RealizedDay | null> {
  try {
    const priceSlots = await fetchPricesForDate(priceArea, dateStr);
    if (!priceSlots.length) {
      logLog(`Auto trader: no historical prices for ${dateStr}, skipping settlement`);
      return null;
    }
    const spotByStartMs = new Map(priceSlots.map(s => [s.startMs, s.spot]));
    const dayStartMs = priceSlots[0].startMs;
    const dayEndMs = priceSlots[priceSlots.length - 1].startMs + SLOT_MS;

    const rows = (await influxClient.query(
      `SELECT mean(ac_input_total_active_power) as grid, mean(solar_input_power_1) as pv1, mean(solar_input_power_2) as pv2, mean(ac_output_total_active_power) as house FROM "mpp-solar" WHERE time >= ${dayStartMs}ms AND time < ${dayEndMs}ms GROUP BY time(15m) fill(none)`
    )) as unknown as {
      time: { getNanoTime(): number };
      grid: number | null;
      pv1: number | null;
      pv2: number | null;
      house: number | null;
    }[];

    const revenueSlots: { gridW: number; spot: number }[] = [];
    let pvKwh = 0;
    let houseKwh = 0;
    for (const row of rows) {
      const slotStartMs = Math.round(row.time.getNanoTime() / 1e6);
      const spot = spotByStartMs.get(slotStartMs);
      if (spot === undefined || row.grid === null) continue;
      revenueSlots.push({ gridW: row.grid, spot });
      pvKwh += (((row.pv1 ?? 0) + (row.pv2 ?? 0)) * 0.25) / 1000;
      houseKwh += ((row.house ?? 0) * 0.25) / 1000;
    }
    if (!revenueSlots.length) {
      logLog(`Auto trader: no inverter data for ${dateStr}, skipping settlement`);
      return null;
    }

    const { export_kwh, import_kwh, revenue_sek } = computeRealizedRevenue(revenueSlots, 0.25, fees);
    const realized: RealizedDay = {
      date: dateStr,
      export_kwh,
      import_kwh,
      realized_revenue_sek: revenue_sek,
      pv_kwh: round1(pvKwh),
      house_kwh: round1(houseKwh),
    };

    const fields: Record<string, number> = {
      export_kwh,
      import_kwh,
      realized_revenue_sek: revenue_sek,
      pv_kwh: realized.pv_kwh,
      house_kwh: realized.house_kwh,
    };
    if (forecast) {
      fields.predicted_pv_kwh = forecast.predicted_pv_kwh;
      fields.predicted_house_kwh = forecast.predicted_house_kwh;
      fields.planned_sell_kwh = forecast.planned_sell_kwh;
      fields.pv_error_kwh = round1(realized.pv_kwh - forecast.predicted_pv_kwh);
      fields.house_error_kwh = round1(realized.house_kwh - forecast.predicted_house_kwh);
    }

    // Stamp at local noon of the settled day so it lands unambiguously on that day in Grafana
    await influxClient.writePoints([
      { measurement: "trading_performance", fields, timestamp: new Date(dayStartMs + 12 * 3600 * 1000) },
    ]);

    logLog(
      `Auto trader: settled ${dateStr} — grid revenue ${revenue_sek} SEK (export ${export_kwh} / import ${import_kwh} kWh), ` +
        `PV ${realized.pv_kwh} kWh${forecast ? ` (forecast ${forecast.predicted_pv_kwh}, err ${fields.pv_error_kwh})` : ""}, ` +
        `house ${realized.house_kwh} kWh${forecast ? ` (forecast ${forecast.predicted_house_kwh}, err ${fields.house_error_kwh})` : ""}`
    );
    return realized;
  } catch (e) {
    errorLog(`Auto trader: failed to settle ${dateStr} (non-fatal)`, e);
    return null;
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
