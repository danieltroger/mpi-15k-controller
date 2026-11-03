/**
 * Planner scenarios for the hold pass (holdAllocation.ts): with the terminal value on, a full battery holds
 * through the cheap night instead of carrying the house, as buy windows at hold power that say so; holds stay
 * out of sunny quarters, sells, the user's windows and buy vetoes; short gaps are bridged and short runs
 * dropped; a hold chains to a buy block as a power step; without the terminal value nothing holds. The slot
 * model is simulateHold.selftest.ts's. Run from backend/ with:
 *   yarn node src/autoTrading/holdAllocation.selftest.ts
 */
import { generatePlan, projectWithFixedWindows } from "./planner.ts";
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
import type { FixedWindow, PlannedWindow, PlannerInput, PlanResult } from "./planner.types.ts";

const NIGHT_SPOT = 0.3;
const EXPECTED_SPOT = 1.4;

// ---------- A full battery before a cheap night: hold through it ----------
{
  const off = generatePlan(fullBatteryNight({ hold_enabled: false }));
  const on = generatePlan(fullBatteryNight());
  const holds = holdWindows(on);
  check("full battery: off, nothing is written", off.buys.length === 0 && off.sells.length === 0);
  check("full battery: on, it holds", holds.length > 0, `(${describeWindows(on.buys)})`);
  check(
    "full battery: the night (22:00–06:00) is held",
    heldMinutesBetween(holds, 22, 30) === 8 * 60,
    `(${heldMinutesBetween(holds, 22, 30)} min of it)`
  );
  check(
    "full battery: every hold is a buy window at hold power that says it holds",
    on.buys.every(
      window =>
        window.hold === true &&
        window.kind === "buy" &&
        window.watts === baseKnobs.hold_power_watts &&
        window.reason.startsWith("hold: house on grid at ") &&
        window.reason.includes("battery saved for")
    ),
    `(${on.buys.map(window => window.reason).join(" | ")})`
  );
  check(
    "full battery: no window is shorter than the hold minimum",
    holds.every(window => minutesOf(window) >= 30)
  );
  check(
    "full battery: never in the sun (09:00–15:00 has PV over the house)",
    heldMinutesBetween(holds, 9, 15) === 0 && heldMinutesBetween(holds, 33, 35) === 0
  );
  check(
    "full battery: holding is worth more than not (cash plus the end-of-plan value)",
    planValue(on) > planValue(off) + 5,
    `(${planValue(on).toFixed(1)} vs ${planValue(off).toFixed(1)} SEK)`
  );
  check(
    "full battery: the notes say how much it holds and at which assumptions",
    on.notes.some(note => note.startsWith("Holding in") && note.includes("100 W assumed extra grid draw")),
    `(${on.notes.join(" | ")})`
  );
  // The opportunistic replan compares a fresh plan with the written windows replayed (projectWithFixedWindows):
  // replayed, the holds must count exactly what the plan counted
  const replay = projectWithFixedWindows({ ...fullBatteryNight(), fixedBuys: on.buys.map(asFixedWindow) });
  check(
    "full battery: replaying its own windows gives the plan's value",
    Math.abs(replay.revenueSek + replay.endEnergyValueSek - planValue(on)) < 0.15,
    `(${(replay.revenueSek + replay.endEnergyValueSek).toFixed(1)} vs ${planValue(on).toFixed(1)} SEK)`
  );
  console.log("  holds:", describeWindows(holds));
}

// ---------- Without an active terminal value nothing holds (kept energy would be worth nothing) ----------
{
  const withoutValue = { ...fullBatteryNight(), expectedSpot: undefined };
  check("no expected spot: no holds", holdWindows(generatePlan(withoutValue)).length === 0);
  const outOfSeason = fullBatteryNight();
  outOfSeason.knobs = { ...outOfSeason.knobs, terminal_value_months: everyMonthExcept(outOfSeason.nowMs) };
  check("terminal value out of season: no holds", holdWindows(generatePlan(outOfSeason)).length === 0);
  check(
    "terminal value off: no holds",
    holdWindows(
      generatePlan({ ...fullBatteryNight(), knobs: { ...fullBatteryNight().knobs, terminal_value_mode: "off" } })
    ).length === 0
  );
}

// ---------- Buy windows inside the hold class: no holds planned (the plan and its replay would disagree) ----------
{
  const lowBuyPower = {
    ...fullBatteryNight({}, { socPercent: 20 }),
    knobs: { ...fullBatteryNight().knobs, max_buy_power_watts: 300 },
  };
  const plan = generatePlan(lowBuyPower);
  check(
    "max_buy_power_watts 300 W: no holds, and the notes say why",
    holdWindows(plan).length === 0 &&
      plan.notes.some(note => note.startsWith("No holds planned: the buy charging power (300 W)")),
    `(${plan.notes.join(" | ")})`
  );
  const replay = projectWithFixedWindows({ ...lowBuyPower, fixedBuys: plan.buys.map(asFixedWindow) });
  check(
    "max_buy_power_watts 300 W: replaying the plan's 300 W buys gives the plan's value",
    plan.buys.length > 0 && Math.abs(replay.revenueSek + replay.endEnergyValueSek - planValue(plan)) < 0.15,
    `(${(replay.revenueSek + replay.endEnergyValueSek).toFixed(1)} vs ${planValue(plan).toFixed(1)} SEK, ${plan.buys.length} buys)`
  );
}

// ---------- The margin, the minimum length and bridging ----------
{
  const strictMargin = generatePlan(fullBatteryNight({ hold_margin_sek_per_kwh: 1 }));
  check(
    "a 1 SEK/kWh margin: only the cheap night beats it, no dearer quarter",
    holdWindows(strictMargin).every(window => window.avgSpot <= NIGHT_SPOT + 1e-9) &&
      holdWindows(strictMargin).length > 0,
    `(${describeWindows(holdWindows(strictMargin))})`
  );
  const longMinimum = generatePlan(fullBatteryNight({ hold_min_window_minutes: 240 }));
  check(
    "a 240 min minimum: every hold at least 4 h",
    holdWindows(longMinimum).length > 0 && holdWindows(longMinimum).every(window => minutesOf(window) >= 240),
    `(${describeWindows(holdWindows(longMinimum))})`
  );
  // A dear quarter at 02:00 a hold alone wouldn't take: bridged through within 30 min, split without bridging
  const blipAtMs = testDayStartMs + 26 * HOUR_MS;
  const bridged = holdWindows(generatePlan(fullBatteryNight({}, { blipAtMs })));
  const split = holdWindows(generatePlan(fullBatteryNight({ hold_bridge_minutes: 0 }, { blipAtMs })));
  check(
    "without bridging the night splits at the dear quarter",
    split.some(window => window.endMs === blipAtMs) && split.some(window => window.startMs === blipAtMs + 15 * 60_000),
    `(${describeWindows(split)})`
  );
  check(
    "bridging 30 min holds through it: one window over the night",
    bridged.some(window => window.startMs < blipAtMs && window.endMs > blipAtMs),
    `(${describeWindows(bridged)})`
  );
}

// ---------- Holds stay out of sells, the user's windows and buy vetoes ----------
{
  const userSell: FixedWindow = {
    startMs: testDayStartMs + 23 * HOUR_MS,
    endMs: testDayStartMs + 24 * HOUR_MS,
    watts: 5000,
  };
  const userBuy: FixedWindow = {
    startMs: testDayStartMs + 28 * HOUR_MS,
    endMs: testDayStartMs + 29 * HOUR_MS,
    watts: 3000,
  };
  const veto = { startMs: testDayStartMs + 26 * HOUR_MS, endMs: testDayStartMs + 27 * HOUR_MS };
  const input: PlannerInput = {
    ...fullBatteryNight(),
    fixedSells: [userSell],
    fixedBuys: [userBuy],
    buyVetoWindows: [veto],
  };
  const plan = generatePlan(input);
  const holds = holdWindows(plan);
  const overlaps = (window: { startMs: number; endMs: number }) =>
    holds.some(hold => hold.startMs < window.endMs && hold.endMs > window.startMs);
  check("user windows and vetoes: it still holds around them", holds.length > 0, `(${describeWindows(holds)})`);
  check("user windows and vetoes: no hold over the user's sell", !overlaps(userSell));
  check("user windows and vetoes: no hold over the user's buy", !overlaps(userBuy));
  check("user windows and vetoes: no hold in a buy veto", !overlaps(veto));
  check(
    "user windows and vetoes: no hold over a planned sell or buy",
    !plan.sells.some(overlaps) && !plan.buys.some(window => !window.hold && overlaps(window))
  );
  // Next to the user's 3 kW buy a hold is a power step: no gap, so no EDB0 between them
  check(
    "a hold chains to the user's buy window on both sides",
    holds.some(window => window.endMs === userBuy.startMs) && holds.some(window => window.startMs === userBuy.endMs),
    `(${describeWindows(holds)})`
  );
}

// ---------- An empty battery: the pre-buy block comes first, the holds chain to it ----------
{
  // At 0.1 SEK/kWh the 1.2 SEK morning after the block still holds (at the default 0.2 only the night does)
  const plan = generatePlan(fullBatteryNight({ hold_margin_sek_per_kwh: 0.1 }, { socPercent: 20 }));
  const block = plan.buys.find(window => !window.hold);
  const holds = holdWindows(plan);
  check(
    "empty battery: it pre-buys in the night",
    !!block && block.watts === baseKnobs.max_buy_power_watts,
    `(${describeWindows(plan.buys)})`
  );
  check(
    "empty battery: a hold meets the block as a power step (no EDB0 between: the heavy charge steps down inside a window)",
    !!block && holds.some(window => window.startMs === block.endMs || window.endMs === block.startMs),
    `(${describeWindows(plan.buys)})`
  );
  check(
    "empty battery: holds never overlap the block",
    !!block && holds.every(window => window.endMs <= block.startMs || window.startMs >= block.endMs)
  );
}

// ---------- A very long horizon: the pass stops at its simulation budget, and says so ----------
{
  const longHorizon = generatePlan({ ...fullBatteryNight({}, { priceHours: 130 }), solarWattsAt: () => 0 });
  check(
    "130 h of dark prices: the hold pass stops at its budget and the note says so",
    longHorizon.notes.some(note => note.includes("ran out of simulations")),
    `(${longHorizon.notes.find(note => note.startsWith("Holding") || note.startsWith("No holds"))})`
  );
}

finishSelftest();

/**
 * 13:00, a 90 % battery, 600 W house, PV over the house 09:00–15:00; the night 22:00–06:00 at 0.3 SEK,
 * the evening 17–21 at 2.0, the rest 1.2; the terminal value on at a 1.4 SEK expected spot (V = 2.71 SEK/kWh),
 * no sell pays and nothing needs buying
 */
function fullBatteryNight(
  holdKnobs: Partial<PlannerInput["knobs"]> = {},
  { blipAtMs, socPercent = 90, priceHours = 35 }: { blipAtMs?: number; socPercent?: number; priceHours?: number } = {}
): PlannerInput {
  return withTerminalValue(
    {
      nowMs: testDayStartMs + 13 * HOUR_MS,
      prices: mkPrices(priceHours, hour => {
        const hourOfDay = hour % 24;
        if (blipAtMs !== undefined && testDayStartMs + hour * HOUR_MS === blipAtMs) return 1.6;
        if (hourOfDay >= 22 || hourOfDay < 6) return NIGHT_SPOT;
        if (hourOfDay >= 17 && hourOfDay < 21) return 2.0;
        return 1.2;
      }),
      solarWattsAt: ms => {
        const hourOfDay = ((ms - testDayStartMs) / HOUR_MS) % 24;
        return hourOfDay >= 9 && hourOfDay <= 15 ? 2000 : 0;
      },
      houseLoadWattsAt: () => 600,
      parasiticWatts: 230,
      socPercent,
      capacityWh: 65000,
      constraintTailHours: 12,
      fixedSells: [],
      fixedBuys: [],
      sellVetoWindows: [],
      buyVetoWindows: [],
      knobs: {
        ...baseKnobs,
        allow_arbitrage_buying: true,
        fragmentation_tolerance_sek_per_window: 0.2,
        min_buy_saving_sek_per_kwh: 0.25,
        terminal_value_min_saving_sek_per_kwh: 1,
        hold_enabled: true,
        ...holdKnobs,
      },
    },
    EXPECTED_SPOT
  );
}

function holdWindows(plan: PlanResult): PlannedWindow[] {
  return plan.buys.filter(window => window.hold);
}

function planValue(plan: PlanResult): number {
  return plan.projection.estimatedRevenueSek + (plan.projection.endEnergyValueSek ?? 0);
}

function minutesOf(window: { startMs: number; endMs: number }): number {
  return (window.endMs - window.startMs) / 60_000;
}

/** Held minutes between two hours counted from testDayStartMs */
function heldMinutesBetween(holds: PlannedWindow[], fromHour: number, toHour: number): number {
  const fromMs = testDayStartMs + fromHour * HOUR_MS;
  const toMs = testDayStartMs + toHour * HOUR_MS;
  return holds.reduce(
    (sum, window) => sum + Math.max(0, Math.min(window.endMs, toMs) - Math.max(window.startMs, fromMs)) / 60_000,
    0
  );
}

function asFixedWindow(window: PlannedWindow): FixedWindow {
  return { startMs: window.startMs, endMs: window.endMs, watts: window.watts };
}

function describeWindows(windows: PlannedWindow[]): string {
  return windows
    .map(
      window =>
        `${window.hold ? "hold" : window.kind} ${((window.startMs - testDayStartMs) / HOUR_MS).toFixed(2)}h+${minutesOf(window)}m@${window.watts}`
    )
    .join(", ");
}
