import type Influx from "influx";
import type { MeterCalibrationConfig } from "../config/config.types.ts";
import { errorLog, logLog, warnLog } from "../utilities/logging.ts";
import { addDays, stockholmDateOf } from "../utilities/stockholmDate.ts";
import { SLOT_MS } from "./planner.ts";
import type { PlannedWindow, PlannerInput, PlannerKnobs, PriceSlot15 } from "./planner.types.ts";
import { fetchPriceSlotsForDate } from "./priceService.ts";
import { settleBacklog } from "./settlementBacklog.ts";
import { querySettlementQuarters } from "./settlementGridPower.ts";
import { type AutoTraderState, type DayForecast, type RealizedDay, saveAutoTraderState } from "./autoTraderState.ts";

/**
 * Closes the feedback loop: after a day has fully settled, measure what actually happened at the
 * grid connection and write it next to what the planner had predicted, so forecast bias and realized
 * P&L become queryable in Grafana (InfluxDB measurement `trading_performance`) instead of vanishing
 * into projections nobody checks.
 *
 * The grid figures are what the utility meter would have counted (settlementGridPower.ts, calibrated
 * against its 15-min data in 2026-11: grid/meterEquivalentGrid.ts), not the inverter's own reading,
 * which leaves out the inverter's draw: over 2026-07-04 → 11-02 the reading understated import by 18.5 %,
 * overstated export by 23 % and net revenue by +669 SEK (a mean daily error of 5.5 SEK); the meter
 * equivalent is within −1.1 % / +0.7 % / +22 SEK (0.31 SEK a day), not counting 2026-10-25, when an
 * ~11 kW grid-side load the inverter can't see ran for 4 h. The reading-based figures the settlement
 * used before are still written alongside (inverter_reading_*). Still an estimate, not the bill. Only
 * days after the 2026-07-03 pi17 fix are meaningful, since earlier `ac_input_total_active_power` is
 * firmware-corrupted (see the pi17 protocol patch).
 */

export type { RealizedDay } from "./autoTraderState.ts";

type FeeKnobs = Pick<PlannerKnobs, "sell_bonus_sek_per_kwh" | "buy_surcharges_sek_per_kwh" | "vat_multiplier">;

/** Guards against the startup catch-up and a daily run settling the same day concurrently. */
let settlementInFlight = false;

/**
 * Net grid revenue from per-slot realized import and export (mean W over the slot, each ≥ 0) + that
 * slot's spot price. Pure — same fee accounting as the planner's `simulate`, so realized and projected
 * numbers are comparable.
 */
export function computeRealizedRevenue(
  slots: { importW: number; exportW: number; spot: number }[],
  slotDurationHours: number,
  fees: FeeKnobs
): { export_kwh: number; import_kwh: number; revenue_sek: number } {
  let exportKwh = 0;
  let importKwh = 0;
  let revenueSek = 0;
  for (const { importW, exportW, spot } of slots) {
    const slotExportKwh = (exportW * slotDurationHours) / 1000;
    const slotImportKwh = (importW * slotDurationHours) / 1000;
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
  const todayStr = stockholmDateOf(input.nowMs);
  const horizonEndMs = input.prices.length ? input.prices[input.prices.length - 1].startMs + SLOT_MS : input.nowMs;
  const perDay = new Map<string, { pvKwh: number; houseKwh: number; sellKwh: number }>();
  for (let hourMs = Math.floor(input.nowMs / 3600_000) * 3600_000; hourMs < horizonEndMs; hourMs += 3600_000) {
    const midHourMs = hourMs + 1800_000;
    const date = stockholmDateOf(midHourMs);
    if (date <= todayStr) continue; // today is partial from nowMs; its full forecast was captured yesterday
    const day = perDay.get(date) ?? { pvKwh: 0, houseKwh: 0, sellKwh: 0 };
    day.pvKwh +=
      Math.max(0, input.solarAverageWattsBetween?.(hourMs, hourMs + 3600_000) ?? input.solarWattsAt(midHourMs)) / 1000;
    day.houseKwh += Math.max(0, input.houseLoadWattsAt(midHourMs)) / 1000;
    perDay.set(date, day);
  }
  for (const window of sells) {
    const day = perDay.get(stockholmDateOf((window.startMs + window.endMs) / 2));
    if (day) day.sellKwh += window.expectedKwh;
  }
  for (const [date, day] of perDay) {
    log[date] = {
      predicted_pv_kwh: round1(day.pvKwh),
      predicted_house_kwh: round1(day.houseKwh),
      planned_sell_kwh: round1(day.sellKwh),
    };
  }
  const cutoff = addDays(todayStr, -7);
  state.forecast_log = Object.fromEntries(Object.entries(log).filter(([date]) => date >= cutoff));
}

/**
 * Settle every completed local day not yet measured (up to a few days of backlog, so a transient
 * failure on one day is retried on the next run rather than stranded: settlementBacklog.ts), writing
 * each day's realized P&L + forecast error to InfluxDB. Non-fatal throughout.
 */
export async function settleRecentDays(
  influxClient: Influx.InfluxDB | undefined,
  priceArea: string,
  fees: FeeKnobs,
  meterCalibration: MeterCalibrationConfig,
  state: AutoTraderState
) {
  if (!influxClient || settlementInFlight) return;
  settlementInFlight = true;
  try {
    await settleBacklog({
      today: stockholmDateOf(Date.now()),
      lastSettledDate: state.last_settled_date,
      settleDay: date =>
        settleTradingDay(influxClient, date, priceArea, fees, meterCalibration, state.forecast_log[date]),
      recordSettled: async (date, realized) => {
        state.last_settled_date = date;
        state.last_settlement = { ...realized, settled_at: new Date().toISOString() };
        await saveAutoTraderState(state);
      },
    });
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
  meterCalibration: MeterCalibrationConfig,
  forecast: DayForecast | undefined
): Promise<RealizedDay | null> {
  try {
    const priceSlots = await fetchPriceSlotsForDate(priceArea, dateStr);
    if (!priceSlots.length) {
      logLog(`Auto trader: no historical prices for ${dateStr}, skipping settlement`);
      return null;
    }
    const measured = await measureTradingDay(influxClient, dateStr, priceSlots, fees, meterCalibration);
    if (!measured) return null;
    const { realized, inverterReading, reconstructedQuarters, dayStartMs } = measured;
    const { export_kwh, import_kwh } = realized;
    const revenue_sek = realized.realized_revenue_sek;

    const fields: Record<string, number> = {
      export_kwh,
      import_kwh,
      realized_revenue_sek: revenue_sek,
      pv_kwh: realized.pv_kwh,
      house_kwh: realized.house_kwh,
      // The pre-calibration figures (the inverter's reading, netted per quarter) for continuity with older points
      inverter_reading_export_kwh: inverterReading.export_kwh,
      inverter_reading_import_kwh: inverterReading.import_kwh,
      inverter_reading_revenue_sek: inverterReading.revenue_sek,
      reconstructed_quarters: reconstructedQuarters,
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
      `Auto trader: settled ${dateStr} — grid revenue ${revenue_sek} SEK (export ${export_kwh} / import ${import_kwh} kWh at the meter; ` +
        `inverter reading ${inverterReading.revenue_sek} SEK, ${inverterReading.export_kwh} / ${inverterReading.import_kwh} kWh` +
        `${reconstructedQuarters ? `; ${reconstructedQuarters} quarter(s) rebuilt from stored 10-s means` : ""}), ` +
        `PV ${realized.pv_kwh} kWh${forecast ? ` (forecast ${forecast.predicted_pv_kwh}, err ${fields.pv_error_kwh})` : ""}, ` +
        `house ${realized.house_kwh} kWh${forecast ? ` (forecast ${forecast.predicted_house_kwh}, err ${fields.house_error_kwh})` : ""}`
    );
    return realized;
  } catch (e) {
    errorLog(`Auto trader: failed to settle ${dateStr} (non-fatal)`, e);
    return null;
  }
}

/**
 * One local day's realized figures from its 15-min prices (the whole day, non-empty), read from InfluxDB
 * without writing anything (settleTradingDay writes them; settlementReplay.ts prints them for past days).
 * Null when the day has no inverter data.
 */
export async function measureTradingDay(
  influxClient: Influx.InfluxDB,
  dateStr: string,
  priceSlots: PriceSlot15[],
  fees: FeeKnobs,
  meterCalibration: MeterCalibrationConfig
): Promise<MeasuredTradingDay | null> {
  const spotByStartMs = new Map(priceSlots.map(slot => [slot.startMs, slot.spot]));
  const dayStartMs = priceSlots[0].startMs;
  const dayEndMs = priceSlots[priceSlots.length - 1].startMs + SLOT_MS;
  const { quarters, notes } = await querySettlementQuarters(influxClient, dayStartMs, dayEndMs, meterCalibration);
  if (notes.bucketsWithoutConverterDirection) {
    warnLog(
      `Auto trader: settling ${dateStr}, ${notes.bucketsWithoutConverterDirection} stored 10-s grid reading(s) had no converter direction — counted as converting`
    );
  }

  const meterSlots: { importW: number; exportW: number; spot: number }[] = [];
  const readingSlots: { importW: number; exportW: number; spot: number }[] = [];
  let pvKwh = 0;
  let houseKwh = 0;
  let reconstructedQuarters = 0;
  for (const quarter of quarters) {
    // PV/house are independent of grid — count them even in a slot where grid data is missing
    pvKwh += ((quarter.pvW ?? 0) * 0.25) / 1000;
    houseKwh += ((quarter.houseW ?? 0) * 0.25) / 1000;
    const spot = spotByStartMs.get(quarter.startMs);
    if (spot === undefined) continue;
    if (quarter.meterImportW !== undefined && quarter.meterExportW !== undefined) {
      meterSlots.push({ importW: quarter.meterImportW, exportW: quarter.meterExportW, spot });
      if (quarter.meterSource === "reconstructed") reconstructedQuarters++;
    }
    if (quarter.readingW !== undefined) {
      readingSlots.push({ importW: Math.max(0, quarter.readingW), exportW: Math.max(0, -quarter.readingW), spot });
    }
  }
  if (!meterSlots.length) {
    logLog(`Auto trader: no inverter data for ${dateStr}, skipping settlement`);
    return null;
  }

  const meter = computeRealizedRevenue(meterSlots, 0.25, fees);
  return {
    realized: {
      date: dateStr,
      export_kwh: meter.export_kwh,
      import_kwh: meter.import_kwh,
      realized_revenue_sek: meter.revenue_sek,
      pv_kwh: round1(pvKwh),
      house_kwh: round1(houseKwh),
    },
    inverterReading: computeRealizedRevenue(readingSlots, 0.25, fees),
    reconstructedQuarters,
    dayStartMs,
  };
}

export type MeasuredTradingDay = {
  /** At the meter (meter-equivalent import and export) */
  realized: RealizedDay;
  /** The inverter's own reading netted per quarter: the settlement before the meter calibration */
  inverterReading: ReturnType<typeof computeRealizedRevenue>;
  /** Quarters whose meter figures were rebuilt from stored 10-s means, not the published fields */
  reconstructedQuarters: number;
  dayStartMs: number;
};

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
