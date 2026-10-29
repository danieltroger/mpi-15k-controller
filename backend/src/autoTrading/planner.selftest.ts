/**
 * Synthetic-scenario self-test for the planner. Run from backend/ with:
 *   yarn node src/autoTrading/planner.selftest.ts
 */
import { generatePlan, projectWithFixedWindows, SLOT_MS } from "./planner.ts";
import { computeRealizedRevenue } from "./tradingPerformance.ts";
import { buildElpatronLoadModel, MANUAL_ON_MODEL_HORIZON_MS } from "./elpatronForecast.ts";
import { estimateElpatronWattsByHour } from "./consumptionForecast.ts";
import { rampedSlotExport, sellRampWattsPerMinute, simulate } from "./simulate.ts";
import { effectivePlannerKnob } from "./plannerKnobBounds.ts";
import type { PlannerInput, Slot } from "./planner.types.ts";

const H = 3600_000;
const baseKnobs = {
  max_sell_power_watts: 15000,
  min_sell_power_watts: 1500,
  inverter_max_ac_output_watts: 15000,
  max_buy_power_watts: 10000,
  planner_soc_floor_percent: 20,
  runtime_soc_floor_percent: 15,
  emergency_soc_floor_percent: 3,
  extra_reserve_kwh: 0,
  min_sell_spot_sek_per_kwh: 0.08,
  min_gain_sek_per_slot: 0.25,
  min_window_minutes: 30,
  charge_efficiency: 0.95,
  discharge_efficiency: 0.93,
  buy_surcharges_sek_per_kwh: 1.186,
  vat_multiplier: 1.25,
  sell_bonus_sek_per_kwh: 0.092,
  min_buy_saving_sek_per_kwh: 0.3,
  baseline_feed_watts: 350,
  // Existing scenarios predate ramp modeling, arbitrage and the sunny floor — keep them
  // isolated (sunny floor == planner floor disables the relaxation)
  sell_ramp_minutes: 0,
  allow_arbitrage_buying: false,
  planner_soc_floor_sunny_percent: 20,
};

// t0 = a midnight-aligned "now"
const t0 = Math.floor(Date.now() / (24 * H)) * 24 * H;

function mkPrices(hours: number, priceAtHour: (h: number) => number) {
  const out: { startMs: number; spot: number }[] = [];
  for (let ms = t0; ms < t0 + hours * H; ms += SLOT_MS) {
    out.push({ startMs: ms, spot: priceAtHour((ms - t0) / H) });
  }
  return out;
}

const fails: string[] = [];
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name} ${detail}`);
  if (!cond) fails.push(name);
}

// ---------- Scenario 1: winter deficit → pre-buy at cheap night hours ----------
{
  const input: PlannerInput = {
    nowMs: t0,
    prices: mkPrices(36, h => (h % 24 < 6 ? 0.2 : h % 24 >= 17 && h % 24 <= 21 ? 2.5 : 1.0)),
    solarWattsAt: () => 0,
    houseLoadWattsAt: () => 800,
    parasiticWatts: 230,
    socPercent: 15,
    capacityWh: 65000,
    constraintTailHours: 12,
    fixedSells: [],
    fixedBuys: [],
    sellVetoWindows: [],
    buyVetoWindows: [],
    knobs: baseKnobs,
  };
  const plan = generatePlan(input);
  const buysAtNight = plan.buys.every(w => {
    const h = ((w.startMs - t0) / H) % 24;
    return h < 6.01;
  });
  check("winter: buys scheduled", plan.buys.length > 0, `(${plan.buys.length} windows)`);
  check("winter: buys at cheap night hours", buysAtNight);
  check("winter: no sells at 15% SOC with no sun", plan.sells.length === 0, `(${plan.sells.length})`);
  // Pre-buying at 0.2 to cover 0.2-priced consumption would only add battery losses — the win
  // is displacing expensive-hour imports, visible as cost reduction vs the no-trade baseline.
  check(
    "winter: import bill reduced vs baseline",
    plan.projection.estimatedRevenueSek > plan.projection.baselineRevenueSek + 15,
    `(${plan.projection.estimatedRevenueSek} vs baseline ${plan.projection.baselineRevenueSek} SEK)`
  );
  console.log(
    "  buys:",
    plan.buys.map(w => `${new Date(w.startMs).toISOString()}+${(w.endMs - w.startMs) / 60000}m`).join(", ")
  );
}

// ---------- Scenario 2: sunny surplus, user window respected + veto respected ----------
{
  const sunnyDay = (h: number) => {
    const hh = h % 24;
    return hh >= 6 && hh <= 20 ? Math.max(0, Math.sin(((hh - 6) / 14) * Math.PI)) * 12000 : 0;
  };
  const priceCurve = (h: number) => {
    const hh = h % 24;
    if (hh >= 19 && hh <= 22) return 1.2; // evening peak
    if (hh >= 7 && hh <= 9) return 0.9; // morning peak
    if (hh >= 11 && hh <= 15) return 0.1; // midday cheap
    return 0.4;
  };
  const userWindow = { startMs: t0 + 30 * H, endMs: t0 + 32 * H, watts: 5000 }; // tomorrow 06:00-08:00
  const veto = { startMs: t0 + 43 * H, endMs: t0 + 46 * H }; // tomorrow 19:00-22:00 vetoed
  const input: PlannerInput = {
    nowMs: t0 + 13 * H, // planning at 13:00 with full next-day prices
    prices: mkPrices(48, priceCurve),
    solarWattsAt: ms => sunnyDay((ms - t0) / H),
    houseLoadWattsAt: () => 600,
    parasiticWatts: 230,
    socPercent: 70,
    capacityWh: 65000,
    constraintTailHours: 12,
    fixedSells: [userWindow],
    fixedBuys: [],
    sellVetoWindows: [veto],
    buyVetoWindows: [],
    knobs: baseKnobs,
  };
  const plan = generatePlan(input);
  const overlapsUser = plan.sells.some(w => w.startMs < userWindow.endMs && w.endMs > userWindow.startMs);
  const overlapsVeto = plan.sells.some(w => w.startMs < veto.endMs && w.endMs > veto.startMs);
  check("sunny: sells planned", plan.sells.length > 0, `(${plan.sells.length} windows)`);
  check("sunny: no overlap with user's fixed window", !overlapsUser);
  check("sunny: vetoed evening range left alone", !overlapsVeto);
  check(
    "sunny: tonight's 19-22 peak used",
    plan.sells.some(w => {
      const h = (w.startMs - t0) / H;
      return h >= 18.9 && h < 23;
    })
  );
  check("sunny: no buying", plan.buys.length === 0);
  check("sunny: min SOC above floor", plan.projection.minSocPercent >= 19.9, `(${plan.projection.minSocPercent}%)`);
  console.log(
    "  sells:",
    plan.sells.map(w => `h${(w.startMs - t0) / H}-h${(w.endMs - t0) / H}@${w.avgSpot.toFixed(2)}`).join(", ")
  );
}

// ---------- Scenario 3: guard projection flags an oversized schedule ----------
{
  const input: PlannerInput = {
    nowMs: t0 + 18 * H,
    prices: mkPrices(24, () => 0.5),
    solarWattsAt: () => 0,
    houseLoadWattsAt: () => 600,
    parasiticWatts: 230,
    socPercent: 40,
    capacityWh: 65000,
    constraintTailHours: 12,
    // 4h of 15kW selling from a 40% battery — must breach the floor
    fixedSells: [{ startMs: t0 + 19 * H, endMs: t0 + 23 * H, watts: 15000 }],
    fixedBuys: [],
    sellVetoWindows: [],
    buyVetoWindows: [],
    knobs: baseKnobs,
  };
  const proj = projectWithFixedWindows(input);
  check(
    "guard: oversized schedule breaches floor",
    proj.violationWh > 1000,
    `(violation ${Math.round(proj.violationWh)} Wh)`
  );
  const projEmpty = projectWithFixedWindows({ ...input, fixedSells: [] });
  check(
    "guard: without the window no breach",
    projEmpty.violationWh < proj.violationWh,
    `(${Math.round(projEmpty.violationWh)} Wh)`
  );
}

// ---------- Scenario 4: extra reserve knob keeps energy back ----------
{
  const priceCurve = (h: number) => (h % 24 >= 19 && h % 24 <= 22 ? 1.2 : 0.3);
  const sunnyDay = (h: number) => {
    const hh = h % 24;
    return hh >= 6 && hh <= 20 ? Math.max(0, Math.sin(((hh - 6) / 14) * Math.PI)) * 12000 : 0;
  };
  const mk = (extra: number): PlannerInput => ({
    nowMs: t0 + 13 * H,
    prices: mkPrices(36, priceCurve),
    solarWattsAt: ms => sunnyDay((ms - t0) / H),
    houseLoadWattsAt: () => 600,
    parasiticWatts: 230,
    socPercent: 90,
    capacityWh: 65000,
    constraintTailHours: 12,
    fixedSells: [],
    fixedBuys: [],
    sellVetoWindows: [],
    buyVetoWindows: [],
    knobs: { ...baseKnobs, extra_reserve_kwh: extra },
  });
  const withoutReserve = generatePlan(mk(0));
  const withReserve = generatePlan(mk(20));
  check(
    "reserve: 20 kWh knob reduces planned selling",
    withReserve.projection.plannedSellKwh < withoutReserve.projection.plannedSellKwh - 10,
    `(${withReserve.projection.plannedSellKwh} vs ${withoutReserve.projection.plannedSellKwh} kWh)`
  );
  check(
    "reserve: min SOC raised accordingly",
    withReserve.projection.minSocPercent > withoutReserve.projection.minSocPercent + 15,
    `(${withReserve.projection.minSocPercent}% vs ${withoutReserve.projection.minSocPercent}%)`
  );
}

// ---------- Scenario 5: arbitrage — winter price spike (modeled on SE3 2026-02-17) ----------
{
  // Dark winter day: night 0.75, evening peak 5.18, no sun, battery low. Without arbitrage the
  // planner only pre-buys the unavoidable deficit and refuses to sell (floor is under pressure).
  // With arbitrage it buys extra cheap energy and sells at the peak — pairs sized so the buys
  // cover the sells after losses, keeping the trajectory floor-safe.
  const priceCurve = (h: number) => {
    const hh = h % 24;
    if (hh >= 17 && hh <= 20) return 5.18;
    if (hh < 6) return 0.75;
    return 1.0;
  };
  const mk = (arbitrage: boolean): PlannerInput => ({
    nowMs: t0,
    prices: mkPrices(30, priceCurve),
    solarWattsAt: () => 0,
    houseLoadWattsAt: () => 600,
    parasiticWatts: 230,
    socPercent: 30,
    capacityWh: 65000,
    constraintTailHours: 6,
    fixedSells: [],
    fixedBuys: [],
    sellVetoWindows: [],
    buyVetoWindows: [],
    knobs: { ...baseKnobs, allow_arbitrage_buying: arbitrage, min_buy_saving_sek_per_kwh: 0.25 },
  });
  const withoutArb = generatePlan(mk(false));
  const withArb = generatePlan(mk(true));
  check(
    "arbitrage: without it, deficit buys but no sells",
    withoutArb.sells.length === 0 && withoutArb.buys.length > 0,
    `(${withoutArb.sells.length} sells, ${withoutArb.buys.length} buys)`
  );
  check("arbitrage: enables selling the evening peak", withArb.sells.length > 0, `(${withArb.sells.length} windows)`);
  const sellsAtPeak = withArb.sells.every(w => {
    const hh = ((w.startMs - t0) / H) % 24;
    return hh >= 16.9 && hh <= 21.1;
  });
  check("arbitrage: sells are at the peak hours", sellsAtPeak);
  check(
    "arbitrage: buys more than the deficit-only plan",
    withArb.projection.plannedBuyKwh > withoutArb.projection.plannedBuyKwh + 5,
    `(${withArb.projection.plannedBuyKwh} vs ${withoutArb.projection.plannedBuyKwh} kWh)`
  );
  check(
    "arbitrage: revenue improves vs deficit-only plan",
    withArb.projection.estimatedRevenueSek > withoutArb.projection.estimatedRevenueSek + 20,
    `(${withArb.projection.estimatedRevenueSek} vs ${withoutArb.projection.estimatedRevenueSek} SEK)`
  );
  console.log(
    "  buys:",
    withArb.buys.map(w => `h${(w.startMs - t0) / H}-h${(w.endMs - t0) / H}@${w.avgSpot.toFixed(2)}`).join(", "),
    "| sells:",
    withArb.sells.map(w => `h${(w.startMs - t0) / H}-h${(w.endMs - t0) / H}@${w.avgSpot.toFixed(2)}`).join(", ")
  );
}

// ---------- Scenario 6: sell ramp — modeling the slow feed-in rampup ----------
{
  const priceCurve = (h: number) => {
    const hh = h % 24;
    if (hh >= 19 && hh <= 21) return 1.2;
    return 0.35;
  };
  const sunnyDay = (h: number) => {
    const hh = h % 24;
    return hh >= 6 && hh <= 20 ? Math.max(0, Math.sin(((hh - 6) / 14) * Math.PI)) * 12000 : 0;
  };
  const mk = (rampMinutes: number): PlannerInput => ({
    nowMs: t0 + 13 * H,
    prices: mkPrices(36, priceCurve),
    solarWattsAt: ms => sunnyDay((ms - t0) / H),
    houseLoadWattsAt: () => 600,
    parasiticWatts: 230,
    socPercent: 85,
    capacityWh: 65000,
    constraintTailHours: 12,
    fixedSells: [],
    fixedBuys: [],
    sellVetoWindows: [],
    buyVetoWindows: [],
    knobs: { ...baseKnobs, sell_ramp_minutes: rampMinutes },
  });
  const noRamp = generatePlan(mk(0));
  const withRamp = generatePlan(mk(10));
  check("ramp: sells exist in both", noRamp.sells.length > 0 && withRamp.sells.length > 0);
  const firstStart = (r: typeof noRamp) => Math.min(...r.sells.map(w => w.startMs));
  check(
    "ramp: window starts at or before the no-ramp start (ramp priced into the pre-peak slot)",
    firstStart(withRamp) <= firstStart(noRamp),
    `(h${(firstStart(withRamp) - t0) / H} vs h${(firstStart(noRamp) - t0) / H})`
  );
  // A fixed 1h sell window delivers less energy when the ramp is modeled → battery ends fuller.
  // Zero solar so nothing refills the difference away.
  const fixedWindowInput = (rampMinutes: number): PlannerInput => ({
    ...mk(rampMinutes),
    solarWattsAt: () => 0,
    fixedSells: [{ startMs: t0 + 19 * H, endMs: t0 + 20 * H, watts: 15000 }],
  });
  const projNoRamp = projectWithFixedWindows(fixedWindowInput(0));
  const projRamp = projectWithFixedWindows(fixedWindowInput(10));
  // Both drain to the emergency floor over this sunless horizon, so the delivered-energy
  // difference shows up as reduced unavoidable import rather than end SOC.
  check(
    "ramp: fixed window exports less energy with ramp modeled",
    projRamp.unavoidableImportKwh < projNoRamp.unavoidableImportKwh - 0.5,
    `(import ${projRamp.unavoidableImportKwh} vs ${projNoRamp.unavoidableImportKwh} kWh)`
  );
  console.log(
    "  no-ramp:",
    noRamp.sells.map(w => `h${(w.startMs - t0) / H}-h${(w.endMs - t0) / H}`).join(", "),
    "| with-ramp:",
    withRamp.sells.map(w => `h${(w.startMs - t0) / H}-h${(w.endMs - t0) / H}`).join(", ")
  );
}

// ---------- Scenario 8: projectWithFixedWindows revenue agrees with generatePlan ----------
// The opportunistic replan compares a fresh plan's projected revenue against the currently
// written windows re-simulated as fixed — those two accountings must match on identical inputs.
{
  const sunnyDay = (h: number) => {
    const hh = h % 24;
    return hh >= 6 && hh <= 20 ? Math.max(0, Math.sin(((hh - 6) / 14) * Math.PI)) * 12000 : 0;
  };
  const priceCurve = (h: number) => (h % 24 >= 19 && h % 24 <= 22 ? 1.2 : 0.35);
  const input: PlannerInput = {
    nowMs: t0 + 13 * H,
    prices: mkPrices(36, priceCurve),
    solarWattsAt: ms => sunnyDay((ms - t0) / H),
    houseLoadWattsAt: () => 600,
    parasiticWatts: 230,
    socPercent: 85,
    capacityWh: 65000,
    constraintTailHours: 12,
    fixedSells: [],
    fixedBuys: [],
    sellVetoWindows: [],
    buyVetoWindows: [],
    knobs: baseKnobs,
  };
  const plan = generatePlan(input);
  const replayed = projectWithFixedWindows({
    ...input,
    fixedSells: plan.sells.map(w => ({ startMs: w.startMs, endMs: w.endMs, watts: w.watts })),
    fixedBuys: plan.buys.map(w => ({ startMs: w.startMs, endMs: w.endMs, watts: w.watts })),
  });
  check(
    "replay: fixed-window revenue matches the plan's projection",
    Math.abs(replayed.revenueSek - plan.projection.estimatedRevenueSek) < 0.5,
    `(${replayed.revenueSek} vs ${plan.projection.estimatedRevenueSek} SEK)`
  );
}

// ---------- Scenario 9: realized-revenue accounting (settlement) ----------
{
  const fees = { sell_bonus_sek_per_kwh: 0.092, buy_surcharges_sek_per_kwh: 1.186, vat_multiplier: 1.25 };
  // Four 15-min slots exporting 15 kW (gridW negative) at spot 1.00 → 15 kWh sold
  const exportSlots = Array.from({ length: 4 }, () => ({ gridW: -15000, spot: 1.0 }));
  const sold = computeRealizedRevenue(exportSlots, 0.25, fees);
  check("settle: export kWh from negative grid power", Math.abs(sold.export_kwh - 15) < 0.01, `(${sold.export_kwh})`);
  check("settle: no import counted when exporting", sold.import_kwh === 0);
  check(
    "settle: export revenue = kWh × (spot + bonus)",
    Math.abs(sold.revenue_sek - 15 * (1.0 + 0.092)) < 0.05,
    `(${sold.revenue_sek})`
  );
  // Two slots importing 8 kW (gridW positive) at spot 0.5 → 4 kWh bought at the full fee+VAT
  const importSlots = Array.from({ length: 2 }, () => ({ gridW: 8000, spot: 0.5 }));
  const bought = computeRealizedRevenue(importSlots, 0.25, fees);
  check(
    "settle: import kWh from positive grid power",
    Math.abs(bought.import_kwh - 4) < 0.01,
    `(${bought.import_kwh})`
  );
  check(
    "settle: import cost = kWh × (spot + surcharge) × VAT, negative revenue",
    Math.abs(bought.revenue_sek - -(4 * (0.5 + 1.186) * 1.25)) < 0.05,
    `(${bought.revenue_sek})`
  );
}

// ---------- Scenario 10: tight budget + zigzagging 15-min prices → consolidation cleans up ----------
// The 2026-07-07/08 shape: the greedy takes the top-priced quarters, which zigzag scatters, and
// near budget exhaustion only ramp-crippled isolated slots still "fit". Combs that genuinely
// price better are kept (a stop/start costs nothing but the ramp), but consolidation must
// harvest what the greedy strands: ramp-recovering merges and — key — fractional leftover
// budget as reduced-power window extensions instead of nothing.
{
  const sunnyDay = (h: number) => {
    const hh = h % 24;
    return hh >= 6 && hh <= 20 ? Math.max(0, Math.sin(((hh - 6) / 14) * Math.PI)) * 12000 : 0;
  };
  // Evening peak with per-quarter zigzag (öre-level, like real 15-min day-ahead prices)
  const priceCurve = (h: number) => {
    const hh = h % 24;
    if (hh >= 19 && hh < 22.01) {
      const quarter = Math.round((hh % 1) * 4) % 4;
      return 1.0 + [0.03, 0, 0.02, -0.01][quarter] - 0.005 * (hh - 19);
    }
    return 0.35;
  };
  const input: PlannerInput = {
    nowMs: t0 + 17 * H,
    prices: mkPrices(36, priceCurve),
    solarWattsAt: ms => sunnyDay((ms - t0) / H),
    houseLoadWattsAt: () => 600,
    parasiticWatts: 230,
    socPercent: 52,
    capacityWh: 65000,
    constraintTailHours: 12,
    fixedSells: [],
    fixedBuys: [],
    sellVetoWindows: [],
    buyVetoWindows: [],
    knobs: { ...baseKnobs, sell_ramp_minutes: 10, min_window_minutes: 15 },
  };
  const plan = generatePlan(input);
  const sells = [...plan.sells].sort((a, b) => a.startMs - b.startMs);
  check("consolidate: sells exist under tight budget", sells.length > 0, `(${sells.length} windows)`);
  check(
    "consolidate: fractional budget captured at reduced power",
    sells.some(w => w.watts < baseKnobs.max_sell_power_watts),
    `(watts: ${sells.map(w => w.watts).join(", ")})`
  );
  check(
    "consolidate: floor respected",
    plan.projection.minSocPercent >= 19.9,
    `(min SOC ${plan.projection.minSocPercent}%)`
  );
  check(
    "consolidate: budget actually used",
    plan.projection.plannedSellKwh > 8,
    `(${plan.projection.plannedSellKwh} kWh)`
  );
  console.log("  sells:", sells.map(w => `h${(w.startMs - t0) / H}-h${(w.endMs - t0) / H}@${w.watts}W`).join(", "));
}

// ---------- Scenario 11: sunny floor — morning selling may dip below the night floor ----------
{
  const sunnyDay = (h: number) => {
    const hh = h % 24;
    return hh >= 6 && hh <= 20 ? Math.max(0, Math.sin(((hh - 6) / 14) * Math.PI)) * 12000 : 0;
  };
  // Morning price peak while solar already covers the house
  const priceCurve = (h: number) => {
    const hh = h % 24;
    if (hh >= 8 && hh <= 10) return 1.5;
    return 0.3;
  };
  const mk = (sunnyFloor: number): PlannerInput => ({
    nowMs: t0 + 6 * H,
    prices: mkPrices(30, priceCurve),
    solarWattsAt: ms => sunnyDay((ms - t0) / H),
    houseLoadWattsAt: () => 600,
    parasiticWatts: 230,
    socPercent: 35,
    capacityWh: 65000,
    constraintTailHours: 12,
    fixedSells: [],
    fixedBuys: [],
    sellVetoWindows: [],
    buyVetoWindows: [],
    knobs: {
      ...baseKnobs,
      planner_soc_floor_sunny_percent: sunnyFloor,
      runtime_soc_floor_percent: 5,
    },
  });
  const strict = generatePlan(mk(20)); // sunny floor == planner floor → old behavior
  const relaxed = generatePlan(mk(5));
  // The relaxed plan already sells the whole peak at full power (32.4 kWh); the strict one sells its
  // leftover at reduced power since the greedy's fallback (26.5 → 27.5 kWh), so the gap is ~4.9 kWh
  check(
    "sunnyfloor: relaxed floor sells more at the morning peak",
    relaxed.projection.plannedSellKwh > strict.projection.plannedSellKwh + 4,
    `(${relaxed.projection.plannedSellKwh} vs ${strict.projection.plannedSellKwh} kWh)`
  );
  check(
    "sunnyfloor: dips below the night floor but not below the sunny floor",
    relaxed.projection.minSocPercent < 19 && relaxed.projection.minSocPercent >= 4.9,
    `(min SOC ${relaxed.projection.minSocPercent}%)`
  );
  const minAtHour = (new Date(relaxed.projection.minSocAt).getTime() - t0) / H;
  check("sunnyfloor: the dip happens while the sun is up", minAtHour >= 6 && minAtHour <= 20, `(h${minAtHour})`);
}

// ---------- Scenario 12: reconcile shape (2026-07-06 incident) — after the evening window falls, ----------
// the planner re-fills what is feasible instead of leaving the schedule stranded
{
  const priceCurve = (h: number) => {
    if (h >= 19 && h <= 21) return 1.1; // tonight's peak
    if (h >= 29 && h <= 31) return 1.05; // tomorrow 05:00-07:00
    return 0.4;
  };
  const sunnyDay = (h: number) => {
    const hh = h % 24;
    return hh >= 6 && hh <= 20 ? Math.max(0, Math.sin(((hh - 6) / 14) * Math.PI)) * 12000 : 0;
  };
  // 20:00, evening window just got dropped by the guard (SOC too low to run it): can morning
  // windows come back? The guard now answers by re-planning — this is that re-plan.
  const input: PlannerInput = {
    nowMs: t0 + 20 * H,
    prices: mkPrices(48, priceCurve),
    solarWattsAt: ms => sunnyDay((ms - t0) / H),
    houseLoadWattsAt: () => 800,
    parasiticWatts: 230,
    socPercent: 50,
    capacityWh: 65000,
    constraintTailHours: 12,
    fixedSells: [],
    fixedBuys: [],
    sellVetoWindows: [],
    buyVetoWindows: [],
    knobs: { ...baseKnobs, min_window_minutes: 15 },
  };
  const plan = generatePlan(input);
  check("reconcile: re-plan finds feasible sell windows", plan.sells.length > 0, `(${plan.sells.length} windows)`);
  check(
    "reconcile: floor still respected",
    plan.projection.minSocPercent >= 19.9,
    `(min SOC ${plan.projection.minSocPercent}%)`
  );
  console.log(
    "  sells:",
    plan.sells.map(w => `h${(w.startMs - t0) / H}-h${(w.endMs - t0) / H}@${w.avgSpot.toFixed(2)}`).join(", ")
  );
}

// ---------- Scenario 13: elpatron load model — dawn burn, thermostat top-ups, off at night ----------
// The water heater is our own switched load (solar-gated for airbnb-guest morning showers):
// the model must predict the ~6 kW recovery burn at first light, decay to standing-loss top-ups
// once the tank thermostat band is reached, and nothing outside heating-allowed hours.
{
  const elpatronKnobs = {
    element_watts: 6200,
    tank_wh_per_degree: 480,
    tank_cooling_degrees_per_hour: 1,
    tank_max_temperature: 50,
  };
  // Solar-gated: heating allowed h1..h15 (first light to sunset), tank cooled to 37°C overnight
  const gated = buildElpatronLoadModel({
    nowMs: t0,
    startTempC: 37,
    heatingAllowedAt: ms => (ms - t0) / H >= 1 && (ms - t0) / H <= 15,
    ...elpatronKnobs,
  });
  check("elpatron: no draw before first light", gated(t0 + 0.5 * H) === 0);
  check("elpatron: full burn at first light", gated(t0 + 1.5 * H) === 6200, `(${gated(t0 + 1.5 * H)} W)`);
  check("elpatron: thermostat reached → standing-loss top-ups", gated(t0 + 4 * H) === 480, `(${gated(t0 + 4 * H)} W)`);
  check("elpatron: off after sunset", gated(t0 + 16 * H) === 0);
  let dayKwh = 0;
  for (let ms = t0; ms < t0 + 24 * H; ms += SLOT_MS) dayKwh += (gated(ms) * 0.25) / 1000;
  check(
    "elpatron: daily energy in the observed 8-16 kWh band",
    dayKwh > 8 && dayKwh < 16,
    `(${dayKwh.toFixed(1)} kWh)`
  );
  // always_on mode: only the thermostat limits it — top-ups continue at night
  const ungated = buildElpatronLoadModel({
    nowMs: t0,
    startTempC: 50,
    heatingAllowedAt: () => true,
    ...elpatronKnobs,
  });
  check("elpatron: always-on mode holds the band around the clock", ungated(t0 + 20 * H) === 480);
  // A hand-switched GPIO is a point-in-time observation: modeled for one day, not extrapolated
  // forever (the 2026-07-16/17 over-forecast). Rolling re-plans re-extend while it stays on.
  const manual = buildElpatronLoadModel({
    nowMs: t0,
    startTempC: 50,
    heatingAllowedAt: ms => ms - t0 < MANUAL_ON_MODEL_HORIZON_MS,
    ...elpatronKnobs,
  });
  check("elpatron: manual-on modeled within the first day", manual(t0 + 20 * H) === 480);
  check("elpatron: manual-on not extrapolated past a day", manual(t0 + 30 * H) === 0, `(${manual(t0 + 30 * H)} W)`);
}

// ---------- Scenario 14: elpatron history estimator — element fingerprint vs pellet boiler ----------
// The estimator must attribute element burns (≤ ~12 °C/h, capped ~55 °C) and band-holding hours,
// but nothing to coasting far below the band, and nothing to boiler firings (> 57 °C peaks, up to
// 19 °C/h) or the hours around them — including the post-firing dwell back through the element's
// band, which would otherwise be credited phantom maintenance.
{
  const estimatorKnobs = {
    element_watts: 6200,
    tank_wh_per_degree: 480,
    tank_cooling_degrees_per_hour: 1,
    tank_max_temperature: 55,
  };
  const tankAtHour: [number, number][] = [
    [0, 36],
    [1, 35.6],
    [2, 35.2],
    [3, 34.8],
    [4, 34.4],
    [5, 34], // slow coast far below band
    [6, 34],
    [7, 45],
    [8, 54],
    [9, 55],
    [10, 54.5],
    [11, 54], // element burn then thermostat band
    [29, 45.5],
    [30, 45],
    [31, 60],
    [32, 66],
    [33, 58], // boiler firing: +15 °C/h to 66
    [34, 56.5],
    [35, 55.8],
    [36, 55.2],
    [37, 54.6], // post-firing dwell back through the band
  ];
  const tankByMs = new Map(tankAtHour.map(([hour, temperature]) => [t0 + hour * H, temperature]));
  const estimate = estimateElpatronWattsByHour(tankByMs, estimatorKnobs);
  const atHour = (hour: number) => estimate.get(t0 + hour * H);
  check("history: slow coast far below band attributes nothing", atHour(2) === 0, `(${atHour(2)} W)`);
  check("history: element burn attributed at ~full power", (atHour(6) ?? 0) > 5000, `(${atHour(6)} W)`);
  check("history: band-holding hour credited the standing loss", atHour(10) === 240, `(${atHour(10)} W)`);
  check(
    "history: boiler firing attributes nothing",
    atHour(30) === 0 && atHour(31) === 0,
    `(${atHour(30)}/${atHour(31)} W)`
  );
  check("history: post-firing dwell in the band attributes nothing", atHour(34) === 0, `(${atHour(34)} W)`);
}

// ---------- Scenario 15: leftover budget → reduced power in the best evening quarter (2026-10-29 08:07) ----------
// The reserve floor binds at dawn tomorrow; 16:45 and 17:00 take most of the budget at full power and
// the leftover fits no full evening quarter. The full-power-only greedy then rejected every evening
// quarter and accepted the current slot (~7 min left, small enough at full power) at 1.49 SEK. With the
// reduced-power fallback the leftover goes to the best remaining evening quarter instead.
{
  const eveningSpotsByHour = new Map([
    [16, 2.28],
    [16.25, 2.29],
    [16.5, 2.22],
    [16.75, 2.8],
    [17, 2.31],
    [17.25, 1.94],
    [17.5, 2.2],
    [17.75, 2.11],
    [18, 2.22],
  ]);
  const spotAtHour = (hour: number) => {
    const eveningSpot = eveningSpotsByHour.get(hour);
    if (eveningSpot !== undefined) return eveningSpot;
    if (hour >= 8 && hour < 8.25) return 1.49; // the current slot
    if (hour >= 18.25 && hour < 20) return 1.9;
    if (hour >= 15 && hour < 16) return 1.7;
    return 1.2;
  };
  const autumnSun = (ms: number) => {
    const hourOfDay = ((ms - t0) / H) % 24;
    return hourOfDay >= 7 && hourOfDay <= 15 ? Math.sin(((hourOfDay - 7) / 8) * Math.PI) * 4500 : 0;
  };
  const nowMs = t0 + 8 * H + 7.65 * 60_000; // 08:07:39, ~7.4 min of the 08:00 slot left
  const mk = (minSellPowerWatts: number): PlannerInput => ({
    nowMs,
    prices: mkPrices(24, spotAtHour),
    solarWattsAt: autumnSun,
    houseLoadWattsAt: () => 600,
    parasiticWatts: 230,
    socPercent: 27.5,
    capacityWh: 65000,
    constraintTailHours: 18,
    fixedSells: [],
    fixedBuys: [],
    sellVetoWindows: [],
    buyVetoWindows: [],
    // The live knobs of 2026-10-29
    knobs: {
      ...baseKnobs,
      min_sell_power_watts: minSellPowerWatts,
      planner_soc_floor_percent: 7,
      planner_soc_floor_sunny_percent: 3,
      runtime_soc_floor_percent: 5,
      emergency_soc_floor_percent: 0,
      min_sell_spot_sek_per_kwh: 0.8,
      min_gain_sek_per_slot: 0.5,
      min_window_minutes: 15,
      sell_ramp_minutes: 10,
    },
  });
  const currentSlotStartMs = t0 + 8 * H;
  const sellsInCurrentSlot = (plan: ReturnType<typeof generatePlan>) =>
    plan.sells.filter(w => w.startMs <= currentSlotStartMs && w.endMs > currentSlotStartMs);
  const describeSells = (plan: ReturnType<typeof generatePlan>) =>
    plan.sells.map(w => `h${(w.startMs - t0) / H}-h${(w.endMs - t0) / H}@${w.watts}W/${w.avgSpot.toFixed(2)}`);
  // min_sell_power_watts at the full sell power switches the fallback off: the old greedy
  const fullPowerOnly = generatePlan(mk(15000));
  const withFallback = generatePlan(mk(1500));
  check(
    "leftover: full-power-only greedy reproduces the incident (sells the current partial slot)",
    sellsInCurrentSlot(fullPowerOnly).length === 1,
    `(${describeSells(fullPowerOnly).join(", ")})`
  );
  check(
    "leftover: with the fallback nothing is sold in the current slot",
    sellsInCurrentSlot(withFallback).length === 0,
    `(${describeSells(withFallback).join(", ")})`
  );
  check(
    "leftover: sold at reduced power in an evening quarter",
    withFallback.sells.some(w => w.watts < 15000 && w.watts >= 1500 && w.avgSpot >= 2.2),
    `(${describeSells(withFallback).join(", ")})`
  );
  check(
    "leftover: every sell is in the evening peak",
    withFallback.sells.every(w => w.avgSpot >= 2.2),
    `(${describeSells(withFallback).join(", ")})`
  );
  check(
    "leftover: floor respected",
    withFallback.projection.minSocPercent >= 6.95,
    `(min SOC ${withFallback.projection.minSocPercent}%)`
  );
  check(
    "leftover: revenue beats the full-power-only plan",
    withFallback.projection.estimatedRevenueSek > fullPowerOnly.projection.estimatedRevenueSek + 1,
    `(${withFallback.projection.estimatedRevenueSek} vs ${fullPowerOnly.projection.estimatedRevenueSek} SEK)`
  );
  console.log("  full power only:", describeSells(fullPowerOnly).join(", "));
  console.log("  with fallback:  ", describeSells(withFallback).join(", "));
}

// ---------- Scenario 16: the feed-in ramp is a rate, also for mid-run step-ups ----------
// Measured ~1.4 kW/min whatever the target: a 5 kW target is reached in ~3.5 min, and a 5 → 15 kW
// step-up mid-run climbs for ~7 min (2026-09-14). Decreases are immediate.
{
  const rampKnobs = { ...baseKnobs, sell_ramp_minutes: 10 }; // 15 kW / 10 min = 1.5 kW/min
  const quarterSlots: Slot[] = [0, 1, 2].map(index => ({
    startMs: t0 + index * SLOT_MS,
    endMs: t0 + (index + 1) * SLOT_MS,
    durationH: 0.25,
    spot: 1,
    pvW: 0,
    houseW: 0,
    fixedSellW: 0,
    fixedBuyW: 0,
  }));
  const rampInput: PlannerInput = {
    nowMs: t0,
    prices: [],
    solarWattsAt: () => 0,
    houseLoadWattsAt: () => 0,
    parasiticWatts: 0,
    socPercent: 90,
    capacityWh: 65000,
    constraintTailHours: 0,
    fixedSells: [],
    fixedBuys: [],
    sellVetoWindows: [],
    buyVetoWindows: [],
    knobs: rampKnobs,
  };
  const exportedWh = (sellWatts: number[]) => simulate(rampInput, quarterSlots, sellWatts, [0, 0, 0], 1).sellExportWh;
  // 0 → 5 kW in 3.33 min, then 11.67 min held: (2.5 kW × 3.33 + 5 kW × 11.67) / 60 = 1111 Wh.
  // The old model stretched every start over the full 10 min whatever the target: 833 Wh.
  const fiveKwQuarterWh = exportedWh([5000, 0, 0]);
  check(
    "ramp rate: a 5 kW window delivers more in its first quarter than the old 10-min model",
    Math.abs(fiveKwQuarterWh - 1111.1) < 1 && fiveKwQuarterWh > 833.3 + 200,
    `(${fiveKwQuarterWh.toFixed(1)} Wh, old model 833.3 Wh)`
  );
  // 5 → 15 kW climbs for 6.67 min: (10 kW × 6.67 + 15 kW × 8.33) / 60 = 3194 Wh, not a full 3750 Wh
  const stepUpQuarterWh = exportedWh([5000, 15000, 0]) - fiveKwQuarterWh;
  check(
    "ramp rate: a mid-run step-up ramps",
    Math.abs(stepUpQuarterWh - 3194.4) < 1,
    `(${stepUpQuarterWh.toFixed(1)} Wh, full power would be 3750 Wh)`
  );
  const stepDownQuarterWh = exportedWh([15000, 5000, 0]) - exportedWh([15000, 0, 0]);
  check(
    "ramp rate: a step-down is immediate",
    Math.abs(stepDownQuarterWh - 1250) < 1,
    `(${stepDownQuarterWh.toFixed(1)} Wh)`
  );
  // The 2026-10-29 08:07:40 start: ~7.3 min left of the slot at 15 kW never gets past ~11 kW
  const partialSlot = rampedSlotExport(0, 15000, 7.35, sellRampWattsPerMinute(rampKnobs));
  check(
    "ramp rate: a short slot ends mid-ramp",
    Math.abs(partialSlot.endW - 11025) < 1 && Math.abs(partialSlot.averageW - 5512.5) < 1,
    `(end ${partialSlot.endW} W, average ${partialSlot.averageW} W)`
  );
}

// ---------- Scenario 17: window SOC text for a window in the current slot ----------
// The log read "SOC 29%→29%" for 2026-10-29's 08:00 window: the start SOC was taken after the
// window's own first slot. A window in slot 0 starts from the input SOC.
{
  const input: PlannerInput = {
    nowMs: t0 + 18 * H,
    prices: mkPrices(30, h => (h >= 18 && h < 19 ? 3.0 : 0.5)),
    solarWattsAt: () => 0,
    houseLoadWattsAt: () => 600,
    parasiticWatts: 230,
    socPercent: 90,
    capacityWh: 65000,
    constraintTailHours: 12,
    fixedSells: [],
    fixedBuys: [],
    sellVetoWindows: [],
    buyVetoWindows: [],
    knobs: { ...baseKnobs, min_window_minutes: 15, sell_ramp_minutes: 10 },
  };
  const plan = generatePlan(input);
  const currentSlotWindow = plan.sells.find(w => w.startMs === input.nowMs);
  check(
    "soc text: a window starts in the current slot",
    !!currentSlotWindow,
    `(${plan.sells.map(w => `h${(w.startMs - t0) / H}-h${(w.endMs - t0) / H}@${w.watts}W ${w.reason}`).join(", ")})`
  );
  // The first quarter alone takes ~4 pp, so the old text read "SOC 86%→…"
  check(
    "soc text: it starts from the input SOC",
    !!currentSlotWindow?.reason.includes("SOC 90%→"),
    `(${currentSlotWindow?.reason})`
  );
}

// ---------- Scenario 18: min_sell_power_watts is clamped to its bounds ----------
{
  const inBounds = effectivePlannerKnob("min_sell_power_watts", 2000);
  const tooLow = effectivePlannerKnob("min_sell_power_watts", 300);
  const tooHigh = effectivePlannerKnob("min_sell_power_watts", 20000);
  const notANumber = effectivePlannerKnob("min_sell_power_watts", "1500");
  check("knob: an in-bounds value passes unchanged", inBounds.value === 2000 && !inBounds.correction);
  check(
    "knob: below the minimum is raised to it",
    tooLow.value === 500 && !!tooLow.correction,
    `(${tooLow.correction})`
  );
  check(
    "knob: above the maximum is lowered to it",
    tooHigh.value === 15000 && !!tooHigh.correction,
    `(${tooHigh.correction})`
  );
  check(
    "knob: a non-number falls back to the default",
    notANumber.value === 1500 && !!notANumber.correction,
    `(${notANumber.correction})`
  );
}

console.log(fails.length ? `\n${fails.length} FAILURES: ${fails.join(", ")}` : "\nAll scenarios passed");
process.exit(fails.length ? 1 : 0);
