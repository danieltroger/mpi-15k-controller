import type Influx from "influx";
import { errorLog, logLog } from "../utilities/logging.ts";
import { SLOT_MS } from "./planner.ts";
import type { PlannedWindow, PlannerInput, PlannerKnobs } from "./planner.types.ts";
import { fetchPriceSlotsForDate } from "./priceService.ts";
import { type AutoTraderState, type DayForecast, saveAutoTraderState } from "./autoTraderState.ts";

/**
 * Closes the feedback loop: after a day has fully settled, measure what actually happened at the
 * inverter's grid connection and write it next to what the planner had predicted, so forecast bias
 * and realized P&L become queryable in Grafana (InfluxDB measurement `trading_performance`) instead
 * of vanishing into projections nobody checks.
 *
 * Caveats: figures come from the inverter's own grid-side power sensor, NOT E.ON's billing meter —
 * they'll track it closely but aren't the official settlement (E.ON's real per-15-min meter data
 * would need authenticating against their API; a possible future refinement). Only days after the
 * 2026-07-03 pi17 fix are meaningful, since earlier `ac_input_total_active_power` is
 * firmware-corrupted (see the pi17 protocol patch).
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

/** Guards against the startup catch-up and a daily run settling the same day concurrently. */
let settlementInFlight = false;

/** A local day (Europe/Stockholm) as YYYY-MM-DD. */
export function localDateStr(ms: number): string {
  return new Date(ms).toLocaleDateString("sv-SE", { timeZone: "Europe/Stockholm" });
}

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

/**
 * Snapshot what the forecasts predict per local day so a settled day can later be scored against
 * reality. Only future days are recorded: the horizon loop starts at the current hour, so today's
 * entry would omit the already-past morning — and the full-day forecast for today was captured a
 * day earlier anyway (the daily plan runs after tomorrow's prices publish). Pruned to a week.
 */
export function captureForecastLog(state: AutoTraderState, input: PlannerInput, sells: PlannedWindow[]) {
  const log = state.forecast_log;
  const todayStr = localDateStr(input.nowMs);
  const horizonEndMs = input.prices.length ? input.prices[input.prices.length - 1].startMs + SLOT_MS : input.nowMs;
  const perDay = new Map<string, { pvKwh: number; houseKwh: number; sellKwh: number }>();
  for (let hourMs = Math.floor(input.nowMs / 3600_000) * 3600_000; hourMs < horizonEndMs; hourMs += 3600_000) {
    const midHourMs = hourMs + 1800_000;
    const date = localDateStr(midHourMs);
    if (date <= todayStr) continue; // today is partial from nowMs; its full forecast was captured yesterday
    const day = perDay.get(date) ?? { pvKwh: 0, houseKwh: 0, sellKwh: 0 };
    day.pvKwh += Math.max(0, input.solarWattsAt(midHourMs)) / 1000;
    day.houseKwh += Math.max(0, input.houseLoadWattsAt(midHourMs)) / 1000;
    perDay.set(date, day);
  }
  for (const window of sells) {
    const day = perDay.get(localDateStr((window.startMs + window.endMs) / 2));
    if (day) day.sellKwh += window.expectedKwh;
  }
  for (const [date, day] of perDay) {
    log[date] = {
      predicted_pv_kwh: round1(day.pvKwh),
      predicted_house_kwh: round1(day.houseKwh),
      planned_sell_kwh: round1(day.sellKwh),
    };
  }
  const cutoff = localDateStr(input.nowMs - 7 * 24 * 3600_000);
  state.forecast_log = Object.fromEntries(Object.entries(log).filter(([date]) => date >= cutoff));
}

/**
 * Settle every completed local day not yet measured (up to a few days of backlog, so a transient
 * failure on one day is retried on the next run rather than stranded), writing each day's realized
 * P&L + forecast error to InfluxDB. Non-fatal throughout.
 */
export async function settleRecentDays(
  influxClient: Influx.InfluxDB | undefined,
  priceArea: string,
  fees: FeeKnobs,
  state: AutoTraderState
) {
  if (!influxClient || settlementInFlight) return;
  settlementInFlight = true;
  try {
    const today = localDateStr(Date.now());
    const candidates: string[] = [];
    for (let daysAgo = 3; daysAgo >= 1; daysAgo--) {
      const date = localDateStr(Date.now() - daysAgo * 24 * 3600_000);
      if (date >= today) continue; // only fully-completed days
      if (state.last_settled_date && date <= state.last_settled_date) continue;
      candidates.push(date);
    }
    for (const date of candidates) {
      const realized = await settleTradingDay(influxClient, date, priceArea, fees, state.forecast_log[date]);
      if (!realized) continue; // e.g. prices not yet published / a transient hiccup — retry next run
      state.last_settled_date = date;
      await saveAutoTraderState(state);
    }
  } finally {
    settlementInFlight = false;
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
    const priceSlots = await fetchPriceSlotsForDate(priceArea, dateStr);
    if (!priceSlots.length) {
      logLog(`Auto trader: no historical prices for ${dateStr}, skipping settlement`);
      return null;
    }
    const spotByStartMs = new Map(priceSlots.map(s => [s.startMs, s.spot]));
    const dayStartMs = priceSlots[0].startMs;
    const dayEndMs = priceSlots[priceSlots.length - 1].startMs + SLOT_MS;

    // The influx client has no timeout of its own — don't let a hung query stall settlement silently
    const rows = await Promise.race([
      influxClient.query<{
        time: { getNanoTime(): number };
        grid: number | null;
        pv1: number | null;
        pv2: number | null;
        house: number | null;
      }>(
        `SELECT mean(ac_input_total_active_power) as grid, mean(solar_input_power_1) as pv1, mean(solar_input_power_2) as pv2, mean(ac_output_total_active_power) as house FROM "mpp-solar" WHERE time >= ${dayStartMs}ms AND time < ${dayEndMs}ms GROUP BY time(15m) fill(none)`
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("InfluxDB settlement query timed out")), 60_000)
      ),
    ]);

    const revenueSlots: { gridW: number; spot: number }[] = [];
    let pvKwh = 0;
    let houseKwh = 0;
    for (const row of rows) {
      const slotStartMs = Math.round(row.time.getNanoTime() / 1e6);
      // PV/house are independent of grid — count them even in a slot where grid data is missing
      pvKwh += (((row.pv1 ?? 0) + (row.pv2 ?? 0)) * 0.25) / 1000;
      houseKwh += ((row.house ?? 0) * 0.25) / 1000;
      const spot = spotByStartMs.get(slotStartMs);
      if (spot === undefined || row.grid === null) continue;
      revenueSlots.push({ gridW: row.grid, spot });
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
