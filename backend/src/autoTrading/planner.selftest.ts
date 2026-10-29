/**
 * Synthetic-scenario self-test for the planner. Run from backend/ with:
 *   yarn node src/autoTrading/planner.selftest.ts
 * The feed-in ramp and its slot-0 seed are covered by simulate.selftest.ts, the reduced-power
 * fallback by reducedSellPower.selftest.ts and the knob bounds by plannerKnobBounds.selftest.ts.
 */
import { generatePlan, projectWithFixedWindows, SLOT_MS } from "./planner.ts";
import { computeRealizedRevenue } from "./tradingPerformance.ts";
import { buildElpatronLoadModel, MANUAL_ON_MODEL_HORIZON_MS } from "./elpatronForecast.ts";
import { estimateElpatronWattsByHour } from "./consumptionForecast.ts";
import { baseKnobs, check, finishSelftest, HOUR_MS, mkPrices, testDayStartMs } from "./plannerSelftestFixtures.ts";
import type { PlannerInput } from "./planner.types.ts";

// ---------- Scenario 1: winter deficit → pre-buy at cheap night hours ----------
{
  const input: PlannerInput = {
    nowMs: testDayStartMs,
    prices: mkPrices(36, hour => (hour % 24 < 6 ? 0.2 : hour % 24 >= 17 && hour % 24 <= 21 ? 2.5 : 1.0)),
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
  const buysAtNight = plan.buys.every(window => {
    const hour = ((window.startMs - testDayStartMs) / HOUR_MS) % 24;
    return hour < 6.01;
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
    plan.buys
      .map(window => `${new Date(window.startMs).toISOString()}+${(window.endMs - window.startMs) / 60000}m`)
      .join(", ")
  );
}

// ---------- Scenario 2: sunny surplus, user window respected + veto respected ----------
{
  const sunnyDay = (hour: number) => {
    const hourOfDay = hour % 24;
    return hourOfDay >= 6 && hourOfDay <= 20 ? Math.max(0, Math.sin(((hourOfDay - 6) / 14) * Math.PI)) * 12000 : 0;
  };
  const priceCurve = (hour: number) => {
    const hourOfDay = hour % 24;
    if (hourOfDay >= 19 && hourOfDay <= 22) return 1.2; // evening peak
    if (hourOfDay >= 7 && hourOfDay <= 9) return 0.9; // morning peak
    if (hourOfDay >= 11 && hourOfDay <= 15) return 0.1; // midday cheap
    return 0.4;
  };
  const userWindow = { startMs: testDayStartMs + 30 * HOUR_MS, endMs: testDayStartMs + 32 * HOUR_MS, watts: 5000 }; // tomorrow 06:00-08:00
  const veto = { startMs: testDayStartMs + 43 * HOUR_MS, endMs: testDayStartMs + 46 * HOUR_MS }; // tomorrow 19:00-22:00 vetoed
  const input: PlannerInput = {
    nowMs: testDayStartMs + 13 * HOUR_MS, // planning at 13:00 with full next-day prices
    prices: mkPrices(48, priceCurve),
    solarWattsAt: ms => sunnyDay((ms - testDayStartMs) / HOUR_MS),
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
  const overlapsUser = plan.sells.some(
    window => window.startMs < userWindow.endMs && window.endMs > userWindow.startMs
  );
  const overlapsVeto = plan.sells.some(window => window.startMs < veto.endMs && window.endMs > veto.startMs);
  check("sunny: sells planned", plan.sells.length > 0, `(${plan.sells.length} windows)`);
  check("sunny: no overlap with user's fixed window", !overlapsUser);
  check("sunny: vetoed evening range left alone", !overlapsVeto);
  check(
    "sunny: tonight's 19-22 peak used",
    plan.sells.some(window => {
      const hour = (window.startMs - testDayStartMs) / HOUR_MS;
      return hour >= 18.9 && hour < 23;
    })
  );
  check("sunny: no buying", plan.buys.length === 0);
  check("sunny: min SOC above floor", plan.projection.minSocPercent >= 19.9, `(${plan.projection.minSocPercent}%)`);
  console.log(
    "  sells:",
    plan.sells
      .map(
        window =>
          `h${(window.startMs - testDayStartMs) / HOUR_MS}-h${(window.endMs - testDayStartMs) / HOUR_MS}@${window.avgSpot.toFixed(2)}`
      )
      .join(", ")
  );
}

// ---------- Scenario 3: guard projection flags an oversized schedule ----------
{
  const input: PlannerInput = {
    nowMs: testDayStartMs + 18 * HOUR_MS,
    prices: mkPrices(24, () => 0.5),
    solarWattsAt: () => 0,
    houseLoadWattsAt: () => 600,
    parasiticWatts: 230,
    socPercent: 40,
    capacityWh: 65000,
    constraintTailHours: 12,
    // 4h of 15kW selling from a 40% battery — must breach the floor
    fixedSells: [{ startMs: testDayStartMs + 19 * HOUR_MS, endMs: testDayStartMs + 23 * HOUR_MS, watts: 15000 }],
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
  const priceCurve = (hour: number) => (hour % 24 >= 19 && hour % 24 <= 22 ? 1.2 : 0.3);
  const sunnyDay = (hour: number) => {
    const hourOfDay = hour % 24;
    return hourOfDay >= 6 && hourOfDay <= 20 ? Math.max(0, Math.sin(((hourOfDay - 6) / 14) * Math.PI)) * 12000 : 0;
  };
  const mk = (extra: number): PlannerInput => ({
    nowMs: testDayStartMs + 13 * HOUR_MS,
    prices: mkPrices(36, priceCurve),
    solarWattsAt: ms => sunnyDay((ms - testDayStartMs) / HOUR_MS),
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
  const priceCurve = (hour: number) => {
    const hourOfDay = hour % 24;
    if (hourOfDay >= 17 && hourOfDay <= 20) return 5.18;
    if (hourOfDay < 6) return 0.75;
    return 1.0;
  };
  const mk = (arbitrage: boolean): PlannerInput => ({
    nowMs: testDayStartMs,
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
  const sellsAtPeak = withArb.sells.every(window => {
    const hourOfDay = ((window.startMs - testDayStartMs) / HOUR_MS) % 24;
    return hourOfDay >= 16.9 && hourOfDay <= 21.1;
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
    withArb.buys
      .map(
        window =>
          `h${(window.startMs - testDayStartMs) / HOUR_MS}-h${(window.endMs - testDayStartMs) / HOUR_MS}@${window.avgSpot.toFixed(2)}`
      )
      .join(", "),
    "| sells:",
    withArb.sells
      .map(
        window =>
          `h${(window.startMs - testDayStartMs) / HOUR_MS}-h${(window.endMs - testDayStartMs) / HOUR_MS}@${window.avgSpot.toFixed(2)}`
      )
      .join(", ")
  );
}

// ---------- Scenario 6: sell ramp — modeling the slow feed-in rampup ----------
{
  const priceCurve = (hour: number) => {
    const hourOfDay = hour % 24;
    if (hourOfDay >= 19 && hourOfDay <= 21) return 1.2;
    return 0.35;
  };
  const sunnyDay = (hour: number) => {
    const hourOfDay = hour % 24;
    return hourOfDay >= 6 && hourOfDay <= 20 ? Math.max(0, Math.sin(((hourOfDay - 6) / 14) * Math.PI)) * 12000 : 0;
  };
  const mk = (rampMinutes: number): PlannerInput => ({
    nowMs: testDayStartMs + 13 * HOUR_MS,
    prices: mkPrices(36, priceCurve),
    solarWattsAt: ms => sunnyDay((ms - testDayStartMs) / HOUR_MS),
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
  const firstStart = (rampPlan: typeof noRamp) => Math.min(...rampPlan.sells.map(window => window.startMs));
  check(
    "ramp: window starts at or before the no-ramp start (ramp priced into the pre-peak slot)",
    firstStart(withRamp) <= firstStart(noRamp),
    `(h${(firstStart(withRamp) - testDayStartMs) / HOUR_MS} vs h${(firstStart(noRamp) - testDayStartMs) / HOUR_MS})`
  );
  // A fixed 1h sell window delivers less energy when the ramp is modeled → battery ends fuller.
  // Zero solar so nothing refills the difference away.
  const fixedWindowInput = (rampMinutes: number): PlannerInput => ({
    ...mk(rampMinutes),
    solarWattsAt: () => 0,
    fixedSells: [{ startMs: testDayStartMs + 19 * HOUR_MS, endMs: testDayStartMs + 20 * HOUR_MS, watts: 15000 }],
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
    noRamp.sells
      .map(window => `h${(window.startMs - testDayStartMs) / HOUR_MS}-h${(window.endMs - testDayStartMs) / HOUR_MS}`)
      .join(", "),
    "| with-ramp:",
    withRamp.sells
      .map(window => `h${(window.startMs - testDayStartMs) / HOUR_MS}-h${(window.endMs - testDayStartMs) / HOUR_MS}`)
      .join(", ")
  );
}

// ---------- Scenario 8: projectWithFixedWindows revenue agrees with generatePlan ----------
// The opportunistic replan compares a fresh plan's projected revenue against the currently
// written windows re-simulated as fixed — those two accountings must match on identical inputs.
{
  const sunnyDay = (hour: number) => {
    const hourOfDay = hour % 24;
    return hourOfDay >= 6 && hourOfDay <= 20 ? Math.max(0, Math.sin(((hourOfDay - 6) / 14) * Math.PI)) * 12000 : 0;
  };
  const priceCurve = (hour: number) => (hour % 24 >= 19 && hour % 24 <= 22 ? 1.2 : 0.35);
  const input: PlannerInput = {
    nowMs: testDayStartMs + 13 * HOUR_MS,
    prices: mkPrices(36, priceCurve),
    solarWattsAt: ms => sunnyDay((ms - testDayStartMs) / HOUR_MS),
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
    fixedSells: plan.sells.map(window => ({ startMs: window.startMs, endMs: window.endMs, watts: window.watts })),
    fixedBuys: plan.buys.map(window => ({ startMs: window.startMs, endMs: window.endMs, watts: window.watts })),
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
// near budget exhaustion only ramp-crippled isolated slots still "fit". Consolidation must harvest
// what the greedy strands: ramp-recovering merges and — key — fractional leftover budget as
// reduced-power sells instead of nothing. A comb of single quarters that out-earns the merged plan
// by less than the ramp model's own error is noise; the fragmentation tolerance merges it (PR #77
// review: a 7-tooth comb at +0.2 SEK cost 14 window-edge writes and 7 ramp restarts against 5 and 2).
{
  const sunnyDay = (hour: number) => {
    const hourOfDay = hour % 24;
    return hourOfDay >= 6 && hourOfDay <= 20 ? Math.max(0, Math.sin(((hourOfDay - 6) / 14) * Math.PI)) * 12000 : 0;
  };
  // Evening peak with per-quarter zigzag (öre-level, like real 15-min day-ahead prices)
  const priceCurve = (hour: number) => {
    const hourOfDay = hour % 24;
    if (hourOfDay >= 19 && hourOfDay < 22.01) {
      const quarter = Math.round((hourOfDay % 1) * 4) % 4;
      return 1.0 + [0.03, 0, 0.02, -0.01][quarter] - 0.005 * (hourOfDay - 19);
    }
    return 0.35;
  };
  const mk = (fragmentationToleranceSek: number): PlannerInput => ({
    nowMs: testDayStartMs + 17 * HOUR_MS,
    prices: mkPrices(36, priceCurve),
    solarWattsAt: ms => sunnyDay((ms - testDayStartMs) / HOUR_MS),
    houseLoadWattsAt: () => 600,
    parasiticWatts: 230,
    socPercent: 52,
    capacityWh: 65000,
    constraintTailHours: 12,
    fixedSells: [],
    fixedBuys: [],
    sellVetoWindows: [],
    buyVetoWindows: [],
    knobs: {
      ...baseKnobs,
      sell_ramp_minutes: 10,
      min_window_minutes: 15,
      fragmentation_tolerance_sek_per_window: fragmentationToleranceSek,
    },
  });
  const strictPlan = generatePlan(mk(0));
  const plan = generatePlan(mk(0.2)); // the default tolerance
  const sells = [...plan.sells].sort((earlier, later) => earlier.startMs - later.startMs);
  check("consolidate: sells exist under tight budget", sells.length > 0, `(${sells.length} windows)`);
  check(
    "consolidate: fractional budget captured at reduced power",
    sells.some(window => window.watts < baseKnobs.max_sell_power_watts),
    `(watts: ${sells.map(window => window.watts).join(", ")})`
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
  const strictRuns = sellRunCount(strictPlan.sells);
  const tolerantRuns = sellRunCount(plan.sells);
  check(
    "consolidate: the fragmentation tolerance merges the comb",
    tolerantRuns <= 3 && tolerantRuns < strictRuns,
    `(${tolerantRuns} selling runs vs ${strictRuns} with no tolerance)`
  );
  check(
    "consolidate: at no more than the tolerance per run merged away",
    plan.projection.estimatedRevenueSek >=
      strictPlan.projection.estimatedRevenueSek - 0.2 * (strictRuns - tolerantRuns) - 0.05,
    `(${plan.projection.estimatedRevenueSek} vs ${strictPlan.projection.estimatedRevenueSek} SEK)`
  );
  const describe = (planned: typeof sells) =>
    planned
      .map(
        window =>
          `h${(window.startMs - testDayStartMs) / HOUR_MS}-h${(window.endMs - testDayStartMs) / HOUR_MS}@${window.watts}W`
      )
      .join(", ");
  console.log("  sells:", describe(sells));
  console.log(
    "  no tolerance:",
    describe([...strictPlan.sells].sort((earlier, later) => earlier.startMs - later.startMs))
  );
}

// ---------- Scenario 11: sunny floor — morning selling may dip below the night floor ----------
{
  const sunnyDay = (hour: number) => {
    const hourOfDay = hour % 24;
    return hourOfDay >= 6 && hourOfDay <= 20 ? Math.max(0, Math.sin(((hourOfDay - 6) / 14) * Math.PI)) * 12000 : 0;
  };
  // Morning price peak while solar already covers the house
  const priceCurve = (hour: number) => {
    const hourOfDay = hour % 24;
    if (hourOfDay >= 8 && hourOfDay <= 10) return 1.5;
    return 0.3;
  };
  const mk = (sunnyFloor: number): PlannerInput => ({
    nowMs: testDayStartMs + 6 * HOUR_MS,
    prices: mkPrices(30, priceCurve),
    solarWattsAt: ms => sunnyDay((ms - testDayStartMs) / HOUR_MS),
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
  const minAtHour = (new Date(relaxed.projection.minSocAt).getTime() - testDayStartMs) / HOUR_MS;
  check("sunnyfloor: the dip happens while the sun is up", minAtHour >= 6 && minAtHour <= 20, `(h${minAtHour})`);
}

// ---------- Scenario 12: reconcile shape (2026-07-06 incident) — after the evening window falls, ----------
// the planner re-fills what is feasible instead of leaving the schedule stranded
{
  const priceCurve = (hour: number) => {
    if (hour >= 19 && hour <= 21) return 1.1; // tonight's peak
    if (hour >= 29 && hour <= 31) return 1.05; // tomorrow 05:00-07:00
    return 0.4;
  };
  const sunnyDay = (hour: number) => {
    const hourOfDay = hour % 24;
    return hourOfDay >= 6 && hourOfDay <= 20 ? Math.max(0, Math.sin(((hourOfDay - 6) / 14) * Math.PI)) * 12000 : 0;
  };
  // 20:00, evening window just got dropped by the guard (SOC too low to run it): can morning
  // windows come back? The guard now answers by re-planning — this is that re-plan.
  const input: PlannerInput = {
    nowMs: testDayStartMs + 20 * HOUR_MS,
    prices: mkPrices(48, priceCurve),
    solarWattsAt: ms => sunnyDay((ms - testDayStartMs) / HOUR_MS),
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
    plan.sells
      .map(
        window =>
          `h${(window.startMs - testDayStartMs) / HOUR_MS}-h${(window.endMs - testDayStartMs) / HOUR_MS}@${window.avgSpot.toFixed(2)}`
      )
      .join(", ")
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
    nowMs: testDayStartMs,
    startTempC: 37,
    heatingAllowedAt: ms => (ms - testDayStartMs) / HOUR_MS >= 1 && (ms - testDayStartMs) / HOUR_MS <= 15,
    ...elpatronKnobs,
  });
  check("elpatron: no draw before first light", gated(testDayStartMs + 0.5 * HOUR_MS) === 0);
  check(
    "elpatron: full burn at first light",
    gated(testDayStartMs + 1.5 * HOUR_MS) === 6200,
    `(${gated(testDayStartMs + 1.5 * HOUR_MS)} W)`
  );
  check(
    "elpatron: thermostat reached → standing-loss top-ups",
    gated(testDayStartMs + 4 * HOUR_MS) === 480,
    `(${gated(testDayStartMs + 4 * HOUR_MS)} W)`
  );
  check("elpatron: off after sunset", gated(testDayStartMs + 16 * HOUR_MS) === 0);
  let dayKwh = 0;
  for (let ms = testDayStartMs; ms < testDayStartMs + 24 * HOUR_MS; ms += SLOT_MS) dayKwh += (gated(ms) * 0.25) / 1000;
  check(
    "elpatron: daily energy in the observed 8-16 kWh band",
    dayKwh > 8 && dayKwh < 16,
    `(${dayKwh.toFixed(1)} kWh)`
  );
  // always_on mode: only the thermostat limits it — top-ups continue at night
  const ungated = buildElpatronLoadModel({
    nowMs: testDayStartMs,
    startTempC: 50,
    heatingAllowedAt: () => true,
    ...elpatronKnobs,
  });
  check("elpatron: always-on mode holds the band around the clock", ungated(testDayStartMs + 20 * HOUR_MS) === 480);
  // A hand-switched GPIO is a point-in-time observation: modeled for one day, not extrapolated
  // forever (the 2026-07-16/17 over-forecast). Rolling re-plans re-extend while it stays on.
  const manual = buildElpatronLoadModel({
    nowMs: testDayStartMs,
    startTempC: 50,
    heatingAllowedAt: ms => ms - testDayStartMs < MANUAL_ON_MODEL_HORIZON_MS,
    ...elpatronKnobs,
  });
  check("elpatron: manual-on modeled within the first day", manual(testDayStartMs + 20 * HOUR_MS) === 480);
  check(
    "elpatron: manual-on not extrapolated past a day",
    manual(testDayStartMs + 30 * HOUR_MS) === 0,
    `(${manual(testDayStartMs + 30 * HOUR_MS)} W)`
  );
}

// ---------- Scenario 14: elpatron history estimator — element fingerprint vs pellet boiler ----------
// The estimator must attribute element burns (≤ ~12 °C/hour, capped ~55 °C) and band-holding hours,
// but nothing to coasting far below the band, and nothing to boiler firings (> 57 °C peaks, up to
// 19 °C/hour) or the hours around them — including the post-firing dwell back through the element's
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
    [33, 58], // boiler firing: +15 °C/hour to 66
    [34, 56.5],
    [35, 55.8],
    [36, 55.2],
    [37, 54.6], // post-firing dwell back through the band
  ];
  const tankByMs = new Map(tankAtHour.map(([hour, temperature]) => [testDayStartMs + hour * HOUR_MS, temperature]));
  const estimate = estimateElpatronWattsByHour(tankByMs, estimatorKnobs);
  const atHour = (hour: number) => estimate.get(testDayStartMs + hour * HOUR_MS);
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

// ---------- Scenario 15: window SOC text for a window in the current slot ----------
// The log read "SOC 29%→29%" for 2026-10-29's 08:00 window: the start SOC was taken after the
// window's own first slot. A window in slot 0 starts from the input SOC.
{
  const input: PlannerInput = {
    nowMs: testDayStartMs + 18 * HOUR_MS,
    prices: mkPrices(30, hour => (hour >= 18 && hour < 19 ? 3.0 : 0.5)),
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
  const currentSlotWindow = plan.sells.find(window => window.startMs === input.nowMs);
  check(
    "soc text: a window starts in the current slot",
    !!currentSlotWindow,
    `(${plan.sells.map(window => `h${(window.startMs - testDayStartMs) / HOUR_MS}-h${(window.endMs - testDayStartMs) / HOUR_MS}@${window.watts}W ${window.reason}`).join(", ")})`
  );
  // The first quarter alone takes ~4 pp, so the old text read "SOC 86%→…"
  check(
    "soc text: it starts from the input SOC",
    !!currentSlotWindow?.reason.includes("SOC 90%→"),
    `(${currentSlotWindow?.reason})`
  );
}

finishSelftest();

/** Separate selling runs (time-contiguous chains) — each one is a feed-in ramp and two window-edge writes */
function sellRunCount(sells: { startMs: number; endMs: number }[]): number {
  const starts = new Set(sells.map(window => window.startMs));
  return sells.filter(window => !sells.some(earlier => earlier.endMs === window.startMs) && starts.has(window.startMs))
    .length;
}
