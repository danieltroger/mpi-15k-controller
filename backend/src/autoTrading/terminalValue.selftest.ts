/**
 * Planner scenarios for the terminal value (terminalValue.ts): with it on, a cheap day is stocked up on
 * without an import in sight, and a full battery isn't sold down to the floor at prices below what its
 * energy saves later; off, out of season or without an expected spot, the plan is the one without it. Its
 * math and season rules are covered by simulate.selftest.ts. Run from backend/ with:
 *   yarn node src/autoTrading/terminalValue.selftest.ts
 */
import { generatePlan, projectWithFixedWindows } from "./planner.ts";
import { terminalValueSekPerKwh } from "./terminalValue.ts";
import {
  baseKnobs,
  check,
  everyMonthExcept,
  finishSelftest,
  HOUR_MS,
  mkPrices,
  testDayStartMs,
  withTerminalValue,
} from "./plannerSelftestFixtures.ts";
import type { PlannedWindow, PlannerInput, PlanResult } from "./planner.types.ts";

// ---------- (a) A cheap day with no import in sight: stock up only with the terminal value ----------
// The 2026-10-24/25 shape: every visible quarter ~0 SEK, the battery lasts the horizon, so pre-buying
// "saved" nothing and the tail was priced at the same ~0. A week at ~1 SEK says the energy is worth more.
{
  const cheapDay = cheapDayInput();
  const off = generatePlan(cheapDay);
  const on = generatePlan(withTerminalValue(cheapDay, 1.0));
  check(
    "cheap day: off, nothing is bought (no import in the horizon)",
    off.buys.length === 0 && off.projection.unavoidableImportKwh === 0,
    `(${off.buys.length} buy windows, import ${off.projection.unavoidableImportKwh} kWh)`
  );
  check(
    "cheap day: on, it stocks up",
    on.projection.plannedBuyKwh > 15 && on.projection.endSocPercent > off.projection.endSocPercent + 20,
    `(${on.projection.plannedBuyKwh} kWh bought, end SOC ${on.projection.endSocPercent}% vs ${off.projection.endSocPercent}%)`
  );
  check(
    "cheap day: the buy windows say they stock up for after the horizon",
    on.buys.length > 0 && on.buys.every(window => window.reason.includes("stocking up")),
    `(${on.buys.map(window => window.reason).join(" | ")})`
  );
  check(
    "cheap day: the notes say so, and what the energy is worth",
    on.notes.some(note => note.startsWith("Stocking up")) &&
      on.notes.some(note =>
        note.startsWith("End-of-plan energy valued at 2.29 SEK/kWh (7-day mean spot 1.00, k 0.9)")
      ) &&
      !on.notes.some(note => note.includes("unavoidable import")),
    `(${on.notes.join(" | ")})`
  );
  check("cheap day: no sells either way", off.sells.length === 0 && on.sells.length === 0);
  const windowsKwh = on.buys.reduce((sum, window) => sum + window.expectedKwh, 0);
  check(
    "cheap day: the projection buys exactly what the windows buy",
    Math.abs(windowsKwh - on.projection.plannedBuyKwh) < 0.05,
    `(windows ${windowsKwh.toFixed(2)} kWh, projection ${on.projection.plannedBuyKwh} kWh)`
  );
  // Cheapest first, it filled the battery tomorrow night and then wrote a 15-min top-up every ~2 h as the
  // house drained it: 10 grid-charge windows. Only the end SOC is credited, so one block where the battery
  // has the most room, at the end of the cheap stretch, gets there with one
  const quarterWindows = generatePlan(
    withTerminalValue({ ...cheapDay, knobs: { ...cheapDay.knobs, min_window_minutes: 15 } }, 1.0)
  );
  const lastPricedEndMs = cheapDay.prices[cheapDay.prices.length - 1].startMs + 15 * 60_000;
  check(
    "cheap day: stocking is one block at the end of the cheap stretch, also with 15-min windows",
    on.buys.length === 1 &&
      quarterWindows.buys.length === 1 &&
      quarterWindows.buys[0].endMs === lastPricedEndMs &&
      quarterWindows.projection.endSocPercent >= 95,
    `(${describeWindows(quarterWindows.buys)}, end SOC ${quarterWindows.projection.endSocPercent}%)`
  );
  console.log("  buys:", describeWindows(on.buys));
}

// ---------- (b) A full battery before a dear week: don't sell it down at prices below its value ----------
// The 2026-10-28 shape: 88 % SOC, the visible peaks at 2.3 SEK, the week after at ~1.7. Selling at 2.3
// earns 2.39/kWh, the house then imports at (1.7 + 1.186) × 1.25 = 3.6. With p̂ 1.7 and k 0.9 a DC kWh
// left at the end is worth 3.02 SEK, so only a quarter where 0.93 × (spot + 0.092) beats that is sold:
// spot above 3.155. Tomorrow's 08–09 spike at 3.6 is.
{
  const fullBattery = fullBatteryBeforeDearWeekInput();
  const off = generatePlan(fullBattery);
  const on = generatePlan(withTerminalValue(fullBattery, 1.7));
  const valuePerKwh = terminalValueSekPerKwh(fullBattery.knobs, 1.7);
  const breakEvenSpot = valuePerKwh / fullBattery.knobs.discharge_efficiency - fullBattery.knobs.sell_bonus_sek_per_kwh;
  check(
    "full battery: off, it sells down to the floor, the 2.3 SEK peaks included",
    off.projection.minSocPercent < 20.5 && off.sells.some(window => Math.abs(window.avgSpot - 2.3) < 0.01),
    `(min SOC ${off.projection.minSocPercent}%, ${off.projection.plannedSellKwh} kWh: ${describeWindows(off.sells)})`
  );
  check(
    "full battery: on, it only sells where spot + sell bonus beats the energy's value",
    on.sells.length > 0 && on.sells.every(window => window.avgSpot > breakEvenSpot),
    `(break-even spot ${breakEvenSpot.toFixed(3)}: ${describeWindows(on.sells)})`
  );
  check(
    "full battery: on, it keeps well above the floor",
    on.projection.minSocPercent > 30 && on.projection.plannedSellKwh < off.projection.plannedSellKwh - 5,
    `(min SOC ${on.projection.minSocPercent}%, ${on.projection.plannedSellKwh} vs ${off.projection.plannedSellKwh} kWh sold)`
  );
  check(
    "full battery: on, the note quotes the value",
    on.notes.some(note => note.startsWith("End-of-plan energy valued at 3.02 SEK/kWh (7-day mean spot 1.70, k 0.9)")),
    `(${on.notes.join(" | ")})`
  );
  // The opportunistic replan compares a fresh plan with the written windows replayed as fixed: both must
  // count the terminal value alike
  const replayed = projectWithFixedWindows({
    ...withTerminalValue(fullBattery, 1.7),
    fixedSells: on.sells.map(window => ({ startMs: window.startMs, endMs: window.endMs, watts: window.watts })),
    fixedBuys: on.buys.map(window => ({ startMs: window.startMs, endMs: window.endMs, watts: window.watts })),
  });
  check(
    "full battery: the replayed windows' cash and end-of-plan value match the plan's",
    Math.abs(replayed.revenueSek - on.projection.estimatedRevenueSek) < 0.5 &&
      Math.abs(replayed.endEnergyValueSek - (on.projection.endEnergyValueSek ?? NaN)) < 0.5,
    `(${replayed.revenueSek} + ${replayed.endEnergyValueSek} vs ${on.projection.estimatedRevenueSek} + ${on.projection.endEnergyValueSek} SEK)`
  );
  // The owner-facing figures stay cash: the credit is reported apart, and only while it applies
  check(
    "full battery: the revenue figures are cash, the end-of-plan value apart",
    on.projection.endEnergyValueSek !== undefined &&
      Math.abs(on.projection.endEnergyValueSek - 60.5) < 0.05 &&
      off.projection.endEnergyValueSek === undefined &&
      on.projection.estimatedRevenueSek < 60,
    `(est ${on.projection.estimatedRevenueSek} SEK, end-of-plan value ${on.projection.endEnergyValueSek} SEK)`
  );
  // Off ignores an expected spot it is handed: today's plan, unchanged
  const offWithEstimate = generatePlan({ ...withTerminalValue(fullBattery, 1.7), knobs: fullBattery.knobs });
  check("full battery: off ignores an expected spot", samePlan(offWithEstimate, off));
}

// ---------- (c) On, but out of season or without an expected spot: the plan without it ----------
{
  for (const [scenario, input, expectedSpot] of [
    ["cheap day", cheapDayInput(), 1.0],
    ["full battery", fullBatteryBeforeDearWeekInput(), 1.7],
  ] as const) {
    const off = generatePlan(input);
    const outOfSeason = generatePlan(withTerminalValue(input, expectedSpot, everyMonthExcept(input.nowMs)));
    check(`out of season (${scenario}): the plan is the one with it off`, samePlan(outOfSeason, off, { notes: true }));

    const withoutEstimate = generatePlan({
      ...withTerminalValue(input, expectedSpot),
      expectedSpot: {
        expectedSpot: undefined,
        source: "trailing",
        detail: "no SE3 prices for 2026-10-30: not published",
      },
    });
    check(
      `no expected spot (${scenario}): the plan is the one with it off, and the notes say why`,
      samePlan(withoutEstimate, off) &&
        withoutEstimate.notes.includes("End-of-plan energy not valued: no SE3 prices for 2026-10-30: not published"),
      `(${withoutEstimate.notes.join(" | ")})`
    );
  }
}

// ---------- (d) Off, the pre-buy loop is main's: it keeps every buy that pays (PR #82 review) ----------
// A user buy window counts in importWh from the start, so main's importWh < 500 break never fires: its loop
// tries every candidate. Breaking on the shortfall instead lost the night pre-buy the user's evening sell
// needs (one quarter, est −41 SEK). Main pre-buys 00:00–02:15, 48.8 kWh, est +6.5 SEK.
{
  const plan = generatePlan(userWindowsAroundAPeakInput());
  check(
    "off with user windows: main's pre-buy (00:00–02:15, 48.8 kWh, est +6.5 SEK)",
    plan.buys.length === 1 &&
      plan.buys[0].startMs === testDayStartMs &&
      plan.buys[0].endMs === testDayStartMs + 2.25 * HOUR_MS &&
      plan.projection.plannedBuyKwh === 48.8 &&
      plan.projection.estimatedRevenueSek === 6.5,
    `(${describeWindows(plan.buys)}, ${plan.projection.plannedBuyKwh} kWh, est ${plan.projection.estimatedRevenueSek} SEK)`
  );
}

// ---------- (e) On, the buy blocks don't starve the sells (PR #82 re-review) ----------
// A third-full battery, a cheap night, a 4.75 SEK morning hour and a 3.85 SEK evening, p̂ 0.64 (V 1.92). The
// sells were allocated against the emptier no-buy trajectory, which could spare nothing; the night block then
// filled the battery and nothing sold it: the plan kept 4.75 SEK energy worth 1.92 SEK. Off, the cheapest-first
// pre-buy and arbitrage pairs sell both peaks.
{
  const input = withTerminalValue(lowBatteryBeforePeaksInput(), 0.64);
  const on = generatePlan(input);
  const off = generatePlan({ ...input, knobs: { ...input.knobs, terminal_value_mode: "off" } });
  const asFixed = (windows: PlannedWindow[]) =>
    windows.map(window => ({ startMs: window.startMs, endMs: window.endMs, watts: window.watts }));
  const offUnderOn = projectWithFixedWindows({
    ...input,
    fixedSells: asFixed(off.sells),
    fixedBuys: asFixed(off.buys),
  });
  const onValueSek = on.projection.estimatedRevenueSek + (on.projection.endEnergyValueSek ?? 0);
  check(
    "peaks after the buys: on, the 4.75 SEK hour is sold",
    on.sells.some(window => window.avgSpot === 4.75),
    `(sells ${describeWindows(on.sells)}, buys ${describeWindows(on.buys)})`
  );
  check(
    "peaks after the buys: on does at least as well as the off plan judged its way",
    onValueSek >= offUnderOn.revenueSek + offUnderOn.endEnergyValueSek - 0.5,
    `(${onValueSek.toFixed(1)} vs ${(offUnderOn.revenueSek + offUnderOn.endEnergyValueSek).toFixed(1)} SEK)`
  );
}

// ---------- (f) A buy block never straddles a hole in the price feed (PR #82 re-review) ----------
// Across a missing half hour, a 60-min block split into two 30-min chains, one too short to be written, which
// the projection still counted
{
  const cheapDay = cheapDayInput();
  const gapStartMs = testDayStartMs + 46.75 * HOUR_MS;
  const gapEndMs = gapStartMs + 0.5 * HOUR_MS;
  const withGap = withTerminalValue(
    {
      ...cheapDay,
      prices: cheapDay.prices.filter(price => price.startMs < gapStartMs || price.startMs >= gapEndMs),
      knobs: { ...cheapDay.knobs, min_window_minutes: 60 },
    },
    1.0
  );
  const plan = generatePlan(withGap);
  const windowsKwh = plan.buys.reduce((sum, window) => sum + window.expectedKwh, 0);
  check(
    "price-feed hole: the windows buy what the projection counts, none straddles it",
    plan.buys.length > 0 &&
      Math.abs(windowsKwh - plan.projection.plannedBuyKwh) < 0.05 &&
      plan.buys.every(window => window.endMs <= gapStartMs || window.startMs >= gapEndMs) &&
      plan.buys.every(window => window.endMs - window.startMs >= HOUR_MS),
    `(${describeWindows(plan.buys)}: ${windowsKwh.toFixed(1)} vs ${plan.projection.plannedBuyKwh} kWh)`
  );
}

finishSelftest();

/** Planning at 13:00 with tomorrow's prices: ~0 SEK all the way, 80 % SOC, a dark, frugal house */
function cheapDayInput(): PlannerInput {
  return {
    nowMs: testDayStartMs + 13 * HOUR_MS,
    prices: mkPrices(48, hour => (hour % 24 < 6 ? 0.01 : 0.04)),
    solarWattsAt: () => 0,
    houseLoadWattsAt: () => 300,
    parasiticWatts: 230,
    socPercent: 80,
    capacityWh: 65000,
    constraintTailHours: 0,
    fixedSells: [],
    fixedBuys: [],
    sellVetoWindows: [],
    buyVetoWindows: [],
    knobs: baseKnobs,
  };
}

/** Planning at 13:00: 88 % SOC, 1.75 SEK with 2.3 SEK evening peaks and one 3.6 SEK hour tomorrow 08–09 */
function fullBatteryBeforeDearWeekInput(): PlannerInput {
  return {
    nowMs: testDayStartMs + 13 * HOUR_MS,
    prices: mkPrices(48, hour => {
      if (hour >= 32 && hour < 33) return 3.6;
      return hour % 24 >= 17 && hour % 24 < 21 ? 2.3 : 1.75;
    }),
    solarWattsAt: () => 0,
    houseLoadWattsAt: () => 300,
    parasiticWatts: 140,
    socPercent: 88,
    capacityWh: 65000,
    constraintTailHours: 6,
    fixedSells: [],
    fixedBuys: [],
    sellVetoWindows: [],
    buyVetoWindows: [],
    knobs: { ...baseKnobs, baseline_feed_watts: 0 },
  };
}

/**
 * Planning at midnight: 0.1 SEK until 06, 1.0 by day, 3.5 at 17–20; 30 % SOC; the owner sells 15 kW through
 * 18–20 and tops up 15 kW at 22–23 (the PR #82 review's repro, at the live knobs with arbitrage off)
 */
function userWindowsAroundAPeakInput(): PlannerInput {
  return {
    nowMs: testDayStartMs,
    prices: mkPrices(24, hour => (hour < 6 ? 0.1 : hour >= 17 && hour < 20 ? 3.5 : 1.0)),
    solarWattsAt: () => 0,
    houseLoadWattsAt: () => 700,
    parasiticWatts: 200,
    socPercent: 30,
    capacityWh: 65000,
    constraintTailHours: 0,
    fixedSells: [{ startMs: testDayStartMs + 18 * HOUR_MS, endMs: testDayStartMs + 20 * HOUR_MS, watts: 15000 }],
    fixedBuys: [{ startMs: testDayStartMs + 22 * HOUR_MS, endMs: testDayStartMs + 23 * HOUR_MS, watts: 15000 }],
    sellVetoWindows: [],
    buyVetoWindows: [],
    knobs: {
      ...baseKnobs,
      max_buy_power_watts: 15000,
      planner_soc_floor_percent: 10,
      planner_soc_floor_sunny_percent: 5,
      runtime_soc_floor_percent: 13,
      min_gain_sek_per_slot: 0.05,
      min_window_minutes: 15,
      min_buy_saving_sek_per_kwh: 0.25,
      baseline_feed_watts: 0,
      sell_ramp_minutes: 10,
      fragmentation_tolerance_sek_per_window: 0.2,
    },
  };
}

/**
 * Planning at midnight: 33 % SOC, a cheap night (−0.08…0.28 SEK), 4.75 SEK at 07–08, 3.85 at 17–20, 1.0 otherwise;
 * a dark house at 1 kW (the PR #82 re-review's shape, at live-like knobs with 10 kW buys and 60-min windows)
 */
function lowBatteryBeforePeaksInput(): PlannerInput {
  const nightPrices = [0.02, 0.28, 0.05, 0.07, -0.08, 0.19];
  return {
    nowMs: testDayStartMs,
    prices: mkPrices(24, hour => {
      const wholeHour = Math.floor(hour);
      if (wholeHour < 6) return nightPrices[wholeHour];
      if (wholeHour === 6) return 1.04;
      if (wholeHour === 7) return 4.75;
      return wholeHour >= 17 && wholeHour < 20 ? 3.85 : 1.0;
    }),
    solarWattsAt: () => 0,
    houseLoadWattsAt: () => 1000,
    parasiticWatts: 200,
    socPercent: 33,
    capacityWh: 65000,
    constraintTailHours: 12,
    fixedSells: [],
    fixedBuys: [],
    sellVetoWindows: [],
    buyVetoWindows: [],
    knobs: {
      ...baseKnobs,
      planner_soc_floor_percent: 10,
      planner_soc_floor_sunny_percent: 5,
      runtime_soc_floor_percent: 13,
      min_gain_sek_per_slot: 0.05,
      min_window_minutes: 60,
      min_buy_saving_sek_per_kwh: 0.25,
      sell_ramp_minutes: 10,
      allow_arbitrage_buying: true,
      fragmentation_tolerance_sek_per_window: 0.2,
      terminal_value_min_saving_sek_per_kwh: 1,
    },
  };
}

/** Same windows and projection — and, when asked, the same notes */
function samePlan(plan: PlanResult, reference: PlanResult, { notes = false } = {}): boolean {
  const comparable = (result: PlanResult) =>
    JSON.stringify({
      sells: result.sells,
      buys: result.buys,
      projection: result.projection,
      socSeries: result.socSeries,
      notes: notes ? result.notes : undefined,
    });
  return comparable(plan) === comparable(reference);
}

function describeWindows(windows: PlannedWindow[]): string {
  return windows
    .map(
      window =>
        `h${(window.startMs - testDayStartMs) / HOUR_MS}-h${(window.endMs - testDayStartMs) / HOUR_MS}@${window.avgSpot.toFixed(2)}`
    )
    .join(", ");
}
