/**
 * Standalone dry-run of the trading planner — fetches real prices, weather and consumption history,
 * reads the current SOC from InfluxDB and prints the plan it would make. Writes nothing.
 *
 * Usage (from backend/):
 *   SOC=45 yarn node src/autoTrading/planPreview.ts   # override SOC
 *   yarn node src/autoTrading/planPreview.ts          # SOC from InfluxDB
 */
import { promises as fs_promises } from "fs";
import path from "path";
import process from "process";
import Influx from "influx";
import { default_config } from "../config/config.ts";
import type { Config } from "../config/config.types.ts";
import { inverterIdleWatts, packCapacityWh } from "../battery/ahLedgerDerivedValues.ts";
import { fetchPrices } from "./priceService.ts";
import { fetchSolarForecast } from "./solarForecast.ts";
import { fetchConsumptionForecast } from "./consumptionForecast.ts";
import { fetchElpatronForecast } from "./elpatronForecast.ts";
import { generatePlan } from "./planner.ts";
import type { PlannerInput } from "./planner.types.ts";

const configPath = path.resolve(path.dirname(process.argv[1]), "../..", "config.json");
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
const solar = await fetchSolarForecast(
  at.latitude,
  at.longitude,
  at.solar_model.watts_per_direct_radiation,
  at.solar_model.watts_per_diffuse_radiation
);
const elpatronConfig = { ...default_config.elpatron_switching, ...config.elpatron_switching };
const elpatron = await fetchElpatronForecast({
  elpatronConfig,
  influxClient,
  solarWattsAt: solar.wattsAt,
  nowMs: Date.now(),
});
console.log(
  `Elpatron: ${elpatron.armed ? `armed, tank ${elpatron.tankTempC ?? "?"}°C — modeled as known load` : "not armed"}, stove on: ${elpatron.stoveOn ?? "unknown"}\n`
);
// Same gate as buildPlannerInput: stove off ⇒ history subtraction runs regardless of armed state
const subtractElpatronHistory = elpatron.stoveOn === false || (elpatron.stoveOn === undefined && elpatron.armed);
const consumption = await fetchConsumptionForecast(
  influxClient,
  at.fallback_house_load_watts,
  subtractElpatronHistory ? elpatronConfig : undefined
);

const fixedSells = Object.entries(config.scheduled_power_selling.schedule)
  .map(([start, e]) => ({ startMs: +new Date(start), endMs: +new Date(e.end_time), watts: Number(e.power_watts) }))
  .filter(w => w.endMs > Date.now());
const fixedBuys = Object.entries(config.scheduled_power_buying.schedule)
  .map(([start, e]) => ({ startMs: +new Date(start), endMs: +new Date(e.end_time), watts: Number(e.charging_power) }))
  .filter(w => w.endMs > Date.now());

const input: PlannerInput = {
  nowMs: Date.now(),
  prices: prices.slots,
  solarWattsAt: solar.wattsAt,
  houseLoadWattsAt: ms => consumption.wattsAt(ms) + elpatron.wattsAt(ms),
  parasiticWatts: inverterIdleWatts(config),
  socPercent: soc,
  capacityWh: packCapacityWh(config),
  constraintTailHours: at.constraint_tail_hours,
  fixedSells,
  fixedBuys,
  sellVetoWindows: [],
  buyVetoWindows: [],
  knobs: {
    // Backfill knobs the config file predates, same as the live config merge does
    ...default_config.automatic_trading,
    ...at,
    runtime_soc_floor_percent: Number(config.scheduled_power_selling.only_sell_above_soc),
    baseline_feed_watts: config.feed_from_battery_when_no_solar.feed_amount_watts,
  },
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
  console.log(`BUY  ${fmt(w.startMs)} → ${fmt(w.endMs)} @ ${w.watts}W | ${w.reason}`);
}
if (!plan.sells.length && !plan.buys.length) console.log("(no windows planned)");
console.log("\nNotes:");
for (const n of plan.notes) console.log(" -", n);
console.log("\nProjection:", JSON.stringify(plan.projection, null, 2));
process.exit(0);
