/**
 * Standalone dry-run of the trading planner — fetches real prices, weather and consumption history,
 * reads the current SOC from InfluxDB and prints the plan it would make. Writes nothing.
 *
 * Usage (from backend/):
 *   SOC=45 yarn node src/autoTrading/planPreview.ts   # override SOC
 *   yarn node src/autoTrading/planPreview.ts          # SOC from InfluxDB
 *   TERMINAL_VALUE_MODE=trailing yarn node src/autoTrading/planPreview.ts   # preview the terminal value
 *                                                    # before switching automatic_trading.terminal_value_mode on
 *   TERMINAL_VALUE_MODE=forecast yarn node src/autoTrading/planPreview.ts   # …priced at the SE3 price outlook
 *   METER_CALIBRATION=identity yarn node src/autoTrading/planPreview.ts      # credit what the inverter reads, as
 *                                                    # before the meter calibration (every meter_calibration setting 0)
 *   CONFIG_PATH=/tmp/config.json yarn node src/autoTrading/planPreview.ts   # another config.json than backend/config.json
 */
import { promises as fs_promises } from "fs";
import path from "path";
import process from "process";
import Influx from "influx";
import { default_config, mergeWithDefaults } from "../config/config.ts";
import type { Config } from "../config/config.types.ts";
import { inverterIdleWatts, packCapacityWh } from "../battery/ahLedgerDerivedValues.ts";
import { fetchPrices } from "./priceService.ts";
import { fetchSolarForecast } from "./solarForecast.ts";
import { fetchConsumptionForecast } from "./consumptionForecast.ts";
import { fetchElpatronForecast } from "./elpatronForecast.ts";
import { generatePlan } from "./planner.ts";
import { plannerKnobsFromConfig } from "./plannerKnobs.ts";
import { sellScheduleWindows } from "./sellScheduleWindows.ts";
import { freshMeasuredFeedInW } from "./measuredFeedIn.ts";
import { expectedSpotForPlan } from "./expectedSpot.ts";
import { effectiveTerminalValueMode } from "./terminalValue.ts";
import { IDENTITY_METER_CALIBRATION } from "../grid/meterCalibrationBounds.ts";
import type { MqttValue } from "../sharedTypes.ts";
import type { PlannerInput } from "./planner.types.ts";

const configPath = process.env.CONFIG_PATH ?? path.resolve(path.dirname(process.argv[1]), "../..", "config.json");
const config: Config = JSON.parse(await fs_promises.readFile(configPath, { encoding: "utf-8" }));
const at = config.automatic_trading;
if (!at) {
  console.error("No automatic_trading section in", configPath, "- add it first (see config.ts defaults)");
  process.exit(1);
}

const influxClient = config.influxdb ? new Influx.InfluxDB({ ...config.influxdb }) : undefined;

let soc = process.env.SOC ? parseFloat(process.env.SOC) : undefined;
if (soc === undefined && influxClient) {
  // soc_ah is the (unclamped) SOC the Ah ledger publishes; clamp to [0,100] like the live planner input.
  const [row] = (await influxClient.query(`SELECT last(soc_ah) as soc FROM "soc_values"`)) as unknown as {
    soc: number;
  }[];
  if (row?.soc !== undefined) soc = Math.max(0, Math.min(100, row.soc));
}
if (soc === undefined) {
  console.error("No SOC available — pass SOC=<percent> as env var");
  process.exit(1);
}

console.log(`\n=== Plan preview: SOC ${soc.toFixed(1)}%, area ${at.price_area} ===\n`);

const prices = await fetchPrices(at.price_area);
// Same merge the live config does, so a config.json predating the physical solar model (or a newer
// planner knob) still previews
const mergedConfig = mergeWithDefaults(config);
const tradingConfig = mergedConfig.automatic_trading;
const solar = await fetchSolarForecast(tradingConfig, influxClient);
console.log(
  `Solar: ${solar.model === "fitted" ? "fitted model" : "DEFAULT MASK (no fitted state)"} — daily kWh`,
  Object.entries(solar.dailyKwh)
    .map(([day, kwh]) => `${day}: ${kwh.toFixed(1)}`)
    .join(", "),
  "| snow nowcast",
  JSON.stringify(solar.nowcast),
  "\n"
);
const elpatronConfig = { ...default_config.elpatron_switching, ...config.elpatron_switching };
const elpatron = await fetchElpatronForecast({
  elpatronConfig,
  influxClient,
  solarWattsAt: solar.wattsAt,
  nowMs: Date.now(),
});
console.log(
  `Elpatron: ${elpatron.armed ? `armed, tank ${elpatron.tankTempC ?? "?"}°C — modeled as known load` : "not armed"}\n`
);
const consumption = await fetchConsumptionForecast(influxClient, at.fallback_house_load_watts, elpatronConfig);

// The live trader starts a running sell window from the inverter's measured feed-in; Influx's newest
// grid power point stands in for its in-memory reading here
let gridPowerReading: MqttValue | undefined;
if (influxClient) {
  const [row] = (await influxClient.query(
    `SELECT last(ac_input_total_active_power) AS grid FROM "mpp-solar" WHERE time > now() - 5m`
  )) as unknown as { time: Date; grid: number | null }[];
  if (typeof row?.grid === "number") gridPowerReading = { value: row.grid, time: +row.time };
}
const previewNowMs = Date.now();
const measuredFeedInW = freshMeasuredFeedInW(gridPowerReading, previewNowMs);
console.log(
  `Measured feed-in: ${measuredFeedInW === undefined ? "no fresh grid power reading, a running sell window's ramp is replayed from the schedule" : `${measuredFeedInW} W (grid ${gridPowerReading?.value} W, ${((previewNowMs - (gridPowerReading?.time ?? previewNowMs)) / 1000).toFixed(0)} s old)`}\n`
);

// Backfill knobs the config file predates and correct bounded ones, same as the live trader does
const configuredKnobs = plannerKnobsFromConfig(mergedConfig);
const terminalValueModeOverride = process.env.TERMINAL_VALUE_MODE
  ? effectiveTerminalValueMode(process.env.TERMINAL_VALUE_MODE)
  : undefined;
if (terminalValueModeOverride?.correction) console.log(`TERMINAL_VALUE_MODE: ${terminalValueModeOverride.correction}`);
const meterCalibrationIdentity = process.env.METER_CALIBRATION === "identity";
console.log(
  `Meter calibration: ${meterCalibrationIdentity ? "identity (METER_CALIBRATION=identity): revenue at the inverter's reading" : JSON.stringify(configuredKnobs.meter_calibration)}`
);
const knobs = {
  ...configuredKnobs,
  ...(terminalValueModeOverride ? { terminal_value_mode: terminalValueModeOverride.value } : {}),
  ...(meterCalibrationIdentity ? { meter_calibration: IDENTITY_METER_CALIBRATION } : {}),
};
// The live trader estimates it the same way (planRun.ts); past days' prices are fetched from the price API,
// and for "forecast" the weather from open-meteo
const expectedSpot = await expectedSpotForPlan(
  { ...tradingConfig, ...knobs },
  { nowMs: previewNowMs, publishedSlots: prices.slots }
);
console.log(
  expectedSpot
    ? `Expected spot after the horizon (${expectedSpot.source}): ${expectedSpot.expectedSpot === undefined ? "unavailable" : `${expectedSpot.expectedSpot.toFixed(3)} SEK/kWh`} — ${expectedSpot.detail}`
    : `Terminal value: ${knobs.terminal_value_mode === "off" ? "off" : `not in season (months ${knobs.terminal_value_months})`} — TERMINAL_VALUE_MODE=trailing or =forecast previews it`
);
const outlookSummary = expectedSpot?.forecast;
if (outlookSummary?.used) {
  console.log(
    `  outlook issued ${outlookSummary.issueDate} (weather ${outlookSummary.weatherFetchedAt}): ${outlookSummary.days.map(day => `D+${day.leadDays} ${day.date} ${day.predictedMeanSpot.toFixed(3)}`).join(", ")}; mean ${outlookSummary.predictedMeanSpot.toFixed(3)} vs trailing ${outlookSummary.trailingSpot.toFixed(3)}${outlookSummary.limited ? " (held at the deviation limit)" : ""}`
  );
}
console.log();

const runningSellSchedule = sellScheduleWindows(config.scheduled_power_selling.schedule);
const fixedSells = runningSellSchedule.filter(window => window.endMs > Date.now());
const fixedBuys = Object.entries(config.scheduled_power_buying.schedule)
  .map(([start, e]) => ({ startMs: +new Date(start), endMs: +new Date(e.end_time), watts: Number(e.charging_power) }))
  .filter(w => w.endMs > Date.now());

const input: PlannerInput = {
  nowMs: previewNowMs,
  prices: prices.slots,
  solarWattsAt: solar.wattsAt,
  solarAverageWattsBetween: solar.averageWattsBetween,
  houseLoadWattsAt: ms => consumption.wattsAt(ms) + elpatron.wattsAt(ms),
  parasiticWatts: inverterIdleWatts(config),
  socPercent: soc,
  capacityWh: packCapacityWh(config),
  constraintTailHours: at.constraint_tail_hours,
  fixedSells,
  fixedBuys,
  runningSellSchedule,
  measuredFeedInW,
  sellVetoWindows: [],
  buyVetoWindows: [],
  expectedSpot,
  knobs,
};

if (fixedSells.length || fixedBuys.length) {
  console.log("Existing (fixed) windows respected:");
  for (const w of fixedSells)
    console.log(`  sell ${new Date(w.startMs).toISOString()} → ${new Date(w.endMs).toISOString()} @ ${w.watts}W`);
  for (const w of fixedBuys)
    console.log(`  buy  ${new Date(w.startMs).toISOString()} → ${new Date(w.endMs).toISOString()} @ ${w.watts}W`);
  console.log();
}

const started = Date.now();
const plan = generatePlan(input);
console.log(`\n=== Result (planner took ${Date.now() - started}ms) ===`);
const fmt = (ms: number) =>
  new Date(ms).toLocaleString("sv-SE", {
    timeZone: "Europe/Stockholm",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
for (const w of plan.sells) {
  console.log(`SELL ${fmt(w.startMs)} → ${fmt(w.endMs)} @ ${w.watts}W | ${w.reason}`);
}
for (const w of plan.buys) {
  console.log(`${w.hold ? "HOLD" : "BUY "} ${fmt(w.startMs)} → ${fmt(w.endMs)} @ ${w.watts}W | ${w.reason}`);
}
if (!plan.sells.length && !plan.buys.length) console.log("(no windows planned)");
console.log("\nNotes:");
for (const n of plan.notes) console.log(" -", n);
console.log("\nProjection:", JSON.stringify(plan.projection, null, 2));
process.exit(0);
