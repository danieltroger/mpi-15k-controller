/**
 * Read-only replay of the settlement over past days: what settling each day now gives (at the meter, through
 * settlementGridPower.ts with the configured calibration), next to what the inverter's reading gives (the
 * settlement before the meter calibration) and, with the utility's 15-min meter exports, what the meter
 * counted. For checking the calibration against a fresh meter export, or redoing it. Writes nothing.
 *
 * Usage (from backend/):
 *   yarn node src/autoTrading/settlementReplay.ts 2026-07-04 2026-11-02
 *   METER_IMPORT_CSV=… METER_EXPORT_CSV=… yarn node src/autoTrading/settlementReplay.ts 2026-07-04 2026-11-02
 *   METER_CALIBRATION=identity …   # every calibration setting 0
 *   CONFIG_PATH=/tmp/config.json … # another config.json than backend/config.json (its influxdb and fees)
 */
import { promises as fs_promises } from "fs";
import path from "path";
import process from "process";
import Influx from "influx";
import { mergeWithDefaults } from "../config/config.ts";
import type { Config } from "../config/config.types.ts";
import { correctedMeterCalibration } from "../grid/correctedMeterCalibration.ts";
import { IDENTITY_METER_CALIBRATION } from "../grid/meterCalibrationBounds.ts";
import { parseUtilityMeterCsv } from "../grid/utilityMeterCsv.ts";
import { addDays } from "../utilities/stockholmDate.ts";
import { fetchPriceSlotsForDate } from "./priceService.ts";
import { computeRealizedRevenue, measureTradingDay } from "./tradingPerformance.ts";

const [firstDate, lastDate] = process.argv.slice(2);
if (!firstDate || !lastDate) {
  console.error("Usage: yarn node src/autoTrading/settlementReplay.ts <first YYYY-MM-DD> <last YYYY-MM-DD>");
  process.exit(1);
}
const configPath = process.env.CONFIG_PATH ?? path.resolve(path.dirname(process.argv[1]), "../..", "config.json");
const config = mergeWithDefaults(
  JSON.parse(await fs_promises.readFile(configPath, { encoding: "utf-8" })) as Partial<Config>
);
if (!config.influxdb) {
  console.error("No influxdb section in", configPath);
  process.exit(1);
}
const influxClient = new Influx.InfluxDB({ ...config.influxdb });
const fees = config.automatic_trading;
const calibration =
  process.env.METER_CALIBRATION === "identity"
    ? IDENTITY_METER_CALIBRATION
    : correctedMeterCalibration(config.meter_calibration);
const meter = await loadMeterQuarters(process.env.METER_IMPORT_CSV, process.env.METER_EXPORT_CSV);
console.log("Calibration:", JSON.stringify(calibration));
console.log(
  "date        | at the meter now: import export SEK (rebuilt quarters) | inverter reading: import export SEK" +
    (meter ? " | meter: import export SEK | error now / reading SEK" : "")
);

const totals = { now: emptyTotals(), reading: emptyTotals(), meter: emptyTotals() };
const dailyErrorsNow: number[] = [];
const dailyErrorsReading: number[] = [];
for (let date = firstDate; date <= lastDate; date = addDays(date, 1)) {
  const priceSlots = await fetchPriceSlotsForDate(config.automatic_trading.price_area, date);
  if (!priceSlots.length) {
    console.log(`${date}  no prices`);
    continue;
  }
  const measured = await measureTradingDay(influxClient, date, priceSlots, fees, calibration);
  if (!measured) {
    console.log(`${date}  no inverter data`);
    continue;
  }
  const now = {
    import_kwh: measured.realized.import_kwh,
    export_kwh: measured.realized.export_kwh,
    revenue_sek: measured.realized.realized_revenue_sek,
  };
  let line =
    `${date}  | ${now.import_kwh.toFixed(1).padStart(6)} ${now.export_kwh.toFixed(1).padStart(6)} ${now.revenue_sek.toFixed(1).padStart(7)} (${measured.reconstructedQuarters})` +
    ` | ${measured.inverterReading.import_kwh.toFixed(1).padStart(6)} ${measured.inverterReading.export_kwh.toFixed(1).padStart(6)} ${measured.inverterReading.revenue_sek.toFixed(1).padStart(7)}`;
  if (meter) {
    const meterSlots = priceSlots.map(slot => ({
      importW: ((meter.importKwh.get(slot.startMs) ?? NaN) * 1000) / 0.25,
      exportW: ((meter.exportKwh.get(slot.startMs) ?? NaN) * 1000) / 0.25,
      spot: slot.spot,
    }));
    if (meterSlots.some(slot => !Number.isFinite(slot.importW) || !Number.isFinite(slot.exportW))) {
      console.log(`${line} | meter export doesn't cover the day`);
      continue;
    }
    const meterDay = computeRealizedRevenue(meterSlots, 0.25, fees);
    addTo(totals.meter, meterDay);
    addTo(totals.now, now);
    addTo(totals.reading, measured.inverterReading);
    dailyErrorsNow.push(now.revenue_sek - meterDay.revenue_sek);
    dailyErrorsReading.push(measured.inverterReading.revenue_sek - meterDay.revenue_sek);
    line +=
      ` | ${meterDay.import_kwh.toFixed(1).padStart(6)} ${meterDay.export_kwh.toFixed(1).padStart(6)} ${meterDay.revenue_sek.toFixed(1).padStart(7)}` +
      ` | ${(now.revenue_sek - meterDay.revenue_sek).toFixed(1).padStart(6)} ${(measured.inverterReading.revenue_sek - meterDay.revenue_sek).toFixed(1).padStart(6)}`;
  } else {
    addTo(totals.now, now);
    addTo(totals.reading, measured.inverterReading);
  }
  console.log(line);
}

console.log(`\nTotals over ${dailyErrorsNow.length || "the"} days:`);
for (const [name, total] of Object.entries(totals)) {
  if (name === "meter" && !meter) continue;
  console.log(
    `  ${name.padEnd(8)} import ${total.import_kwh.toFixed(1)} kWh, export ${total.export_kwh.toFixed(1)} kWh, net revenue ${total.revenue_sek.toFixed(0)} SEK` +
      (meter && name !== "meter" ? ` (${signed(total.revenue_sek - totals.meter.revenue_sek)} SEK vs the meter)` : "")
  );
}
if (meter) {
  console.log(
    `  daily revenue error vs the meter, mean |error|: now ${meanAbsolute(dailyErrorsNow).toFixed(2)} SEK, inverter reading ${meanAbsolute(dailyErrorsReading).toFixed(2)} SEK`
  );
}
process.exit(0);

async function loadMeterQuarters(importCsvPath: string | undefined, exportCsvPath: string | undefined) {
  if (!importCsvPath || !exportCsvPath) return undefined;
  const [importCsv, exportCsv] = await Promise.all(
    [importCsvPath, exportCsvPath].map(csvPath => fs_promises.readFile(csvPath, { encoding: "utf-8" }))
  );
  const imported = parseUtilityMeterCsv(importCsv);
  const exported = parseUtilityMeterCsv(exportCsv);
  if (imported.direction !== "import" || exported.direction !== "export") {
    throw new Error("METER_IMPORT_CSV must be the consumption export and METER_EXPORT_CSV the production export");
  }
  return { importKwh: imported.kwhByQuarterStartMs, exportKwh: exported.kwhByQuarterStartMs };
}

type Totals = { import_kwh: number; export_kwh: number; revenue_sek: number };

function emptyTotals(): Totals {
  return { import_kwh: 0, export_kwh: 0, revenue_sek: 0 };
}

function addTo(total: Totals, day: Totals): void {
  total.import_kwh += day.import_kwh;
  total.export_kwh += day.export_kwh;
  total.revenue_sek += day.revenue_sek;
}

function meanAbsolute(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + Math.abs(value), 0) / values.length : NaN;
}

function signed(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(0)}`;
}
