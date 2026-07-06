/**
 * Synthetic-scenario self-test for the planner. Run from backend/ with:
 *   yarn node src/autoTrading/planner.selftest.ts
 */
import { generatePlan, type PlannerInput, projectWithFixedWindows, SLOT_MS } from "./planner.ts";
import { fitSolarModel, fitIsPlausibleVsCurrent } from "./solarCalibration.ts";

const H = 3600_000;
const baseKnobs = {
  max_sell_power_watts: 15000,
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
  // Existing scenarios predate ramp modeling and arbitrage — keep them isolated
  sell_ramp_minutes: 0,
  allow_arbitrage_buying: false,
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

// ---------- Scenario 7: solar model re-fit recovers known coefficients ----------
{
  const samples: { direct: number; diffuse: number; pvWatts: number }[] = [];
  let seed = 42;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let i = 0; i < 800; i++) {
    const direct = rand() * 700;
    const diffuse = 50 + rand() * 250;
    const pv = 10 * direct + 16 * diffuse + (rand() - 0.5) * 400;
    samples.push({ direct, diffuse, pvWatts: Math.max(0, pv) });
  }
  const fit = fitSolarModel(samples);
  check("solarfit: fit succeeds", fit.ok);
  if (fit.ok) {
    check(
      "solarfit: recovers direct coefficient",
      Math.abs(fit.watts_per_direct_radiation - 10) < 1,
      `(${fit.watts_per_direct_radiation})`
    );
    check(
      "solarfit: recovers diffuse coefficient",
      Math.abs(fit.watts_per_diffuse_radiation - 16) < 2,
      `(${fit.watts_per_diffuse_radiation})`
    );
    check("solarfit: R² high on clean data", fit.r2 > 0.9, `(${fit.r2})`);
    check("solarfit: >50% swing gets flagged", typeof fitIsPlausibleVsCurrent(fit, 30, 40) === "string");
    check("solarfit: small drift passes", fitIsPlausibleVsCurrent(fit, 11, 15) === undefined);
  }
  check("solarfit: rejects sparse data", !fitSolarModel(samples.slice(0, 100)).ok);
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

console.log(fails.length ? `\n${fails.length} FAILURES: ${fails.join(", ")}` : "\nAll scenarios passed");
process.exit(fails.length ? 1 : 0);
