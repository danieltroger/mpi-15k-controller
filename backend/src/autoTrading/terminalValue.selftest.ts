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
  // Once full, it tops up single quarters as the house drains it: under the 30-min minimum window they are
  // never written, so the projection must not count them either
  const windowsKwh = on.buys.reduce((sum, window) => sum + window.expectedKwh, 0);
  check(
    "cheap day: the projection buys exactly what the windows buy",
    Math.abs(windowsKwh - on.projection.plannedBuyKwh) < 0.05,
    `(windows ${windowsKwh.toFixed(2)} kWh, projection ${on.projection.plannedBuyKwh} kWh)`
  );
  const quarterWindows = generatePlan(
    withTerminalValue({ ...cheapDay, knobs: { ...cheapDay.knobs, min_window_minutes: 15 } }, 1.0)
  );
  check(
    "cheap day: with 15-min windows (the default) the top-ups are written too",
    quarterWindows.buys.length > on.buys.length &&
      quarterWindows.projection.endSocPercent > on.projection.endSocPercent + 10,
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
    "full battery: the replayed windows' revenue matches the plan's, terminal value included",
    Math.abs(replayed.revenueSek - on.projection.estimatedRevenueSek) < 0.5,
    `(${replayed.revenueSek} vs ${on.projection.estimatedRevenueSek} SEK)`
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
