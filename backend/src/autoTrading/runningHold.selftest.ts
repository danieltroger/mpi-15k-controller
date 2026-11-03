/**
 * Self-test of re-plans around a running hold (runningHold.ts, replanAroundRunningWindows.ts), through the
 * schedule writes the auto-trader makes (scheduleOwnership.ts' applyPlan, activeOwnedEntries). The
 * opportunistic and guard re-plans kept every running window whole, so a hold, once started, ran to the end
 * the plan that wrote it had picked: the freeze is reproduced first, along the path planRun took before.
 * Now a running hold is kept through the current quarter and re-planned after it: it ends at the quarter's end
 * when holding stopped paying, holds past its old end in one window when holding on pays, stays as written
 * when nothing changed, bridges from its current quarter and isn't dropped as short. Running sells and buys,
 * a plan that can't value holds and hold_enabled off keep the old behaviour exactly. Run from backend/ with:
 *   yarn node src/autoTrading/runningHold.selftest.ts
 */
import { isDeepStrictEqual } from "util";
import { default_config } from "../config/config.ts";
import { generatePlan, projectWithFixedWindows } from "./planner.ts";
import { ownedEntriesAsWindows } from "./plannerInputs.ts";
import { replanAroundRunningWindows } from "./replanAroundRunningWindows.ts";
import { activeOwnedEntries, applyPlan, type ScheduleOwnershipContext } from "./scheduleOwnership.ts";
import {
  baseKnobs,
  check,
  finishSelftest,
  HOUR_MS,
  mkPrices,
  testDayStartMs,
  withTerminalValue,
} from "./plannerSelftestFixtures.ts";
import type { Config } from "../config/config.types.ts";
import type { AutoTraderState } from "./autoTraderState.types.ts";
import type { PlannedWindow, PlannerInput, PlanResult } from "./planner.types.ts";
import type { TraderCtx } from "./traderContext.ts";

const MINUTE_MS = 60_000;
const NIGHT_SPOT = 0.3;
const PLAN_AT_MS = testDayStartMs + 13 * HOUR_MS;
/** 01:07 the night after: three hours into the hold, a guard or opportunistic re-plan runs */
const REPLAN_AT_MS = testDayStartMs + 25 * HOUR_MS + 7 * MINUTE_MS;
const CURRENT_QUARTER_END_MS = testDayStartMs + 25 * HOUR_MS + 15 * MINUTE_MS;
const HOLD_START_MS = testDayStartMs + 22 * HOUR_MS;
const HOLD_KEY = new Date(HOLD_START_MS).toISOString();
const NIGHT_END_MS = testDayStartMs + 30 * HOUR_MS;
const MORNING_END_MS = testDayStartMs + 33 * HOUR_MS;

// ---------- The 13:00 plan holds the night; at 01:07 the battery's energy is worth far less ----------
const planA = generatePlan(nightInput(PLAN_AT_MS));
check(
  "13:00: the plan holds through the night, 22:00–06:00, in one window",
  planA.buys.some(window => window.hold && window.startMs === HOLD_START_MS && window.endMs === NIGHT_END_MS),
  `(${describeWindows(planA.buys)})`
);
const socAtReplan = socAt(planA, REPLAN_AT_MS);
// The trailing mean moved at midnight: kept energy is worth 1.45 SEK/kWh instead of 2.71, the evening peak pays more
const cheapEnergy = nightInput(REPLAN_AT_MS, { expectedSpot: 0.2, socPercent: socAtReplan });
check(
  "01:07, energy worth less: a fresh plan holds none of the rest of the night",
  !generatePlan(cheapEnergy).buys.some(window => window.hold && window.startMs < NIGHT_END_MS)
);

{
  // Before: planRun kept the running hold whole as a fixed window, and kept its entry
  const before = afterPlanA();
  const running = activeOwnedEntries(before.ctx, REPLAN_AT_MS);
  const oldResult = generatePlan({
    ...cheapEnergy,
    fixedBuys: [...cheapEnergy.fixedBuys, ...ownedEntriesAsWindows(running.buying, "charging_power")],
  });
  applyPlan(before.ctx, oldResult.sells, oldResult.buys, running);
  check(
    "the freeze, reproduced: the old re-plan path leaves the hold running to 06:00",
    holdEntryEnd(before.config()) === NIGHT_END_MS,
    `(ends ${hoursOf(holdEntryEnd(before.config()))})`
  );

  // Now: the hold runs to the end of the current quarter and stops there
  const after = afterPlanA();
  const replan = replanAroundRunningWindows(cheapEnergy, activeOwnedEntries(after.ctx, REPLAN_AT_MS));
  applyPlan(after.ctx, replan.result.sells, replan.result.buys, replan.keepOwned);
  check(
    "fixed: the hold keeps the current quarter and ends at 01:15, under the same key",
    holdEntryEnd(after.config()) === CURRENT_QUARTER_END_MS,
    `(ends ${hoursOf(holdEntryEnd(after.config()))}; buys ${describeWindows(replan.result.buys)})`
  );
  check(
    "fixed: the shortened entry is still ours, so the next plan can reshape it again",
    after.ctx.state.owned_entries.buying[HOLD_KEY]?.end_time === new Date(CURRENT_QUARTER_END_MS).toISOString()
  );
  const continued = replan.result.buys.find(window => window.startMs === HOLD_START_MS);
  check(
    "fixed: the plan lists it as a hold (the Trading page and the dashboard label it so)",
    continued?.hold === true && replan.result.runningHoldReshaped === true,
    `(${continued?.reason})`
  );
  check(
    "fixed: the notes say the running hold was re-planned and now ends sooner",
    replan.result.notes.some(note => note.startsWith(`Running hold since ${HOLD_KEY}`) && note.includes("instead of")),
    `(${replan.result.notes.find(note => note.startsWith("Running hold"))})`
  );
  // What the gain gate compares: a replay of the plan's own windows must count what the plan counted
  const replay = projectWithFixedWindows({
    ...replan.input,
    runningHold: undefined,
    fixedSells: [...replan.input.fixedSells, ...replan.result.sells],
    fixedBuys: [...replan.input.fixedBuys, ...replan.result.buys],
  });
  check(
    "fixed: replaying the re-planned windows gives the plan's value",
    Math.abs(replay.revenueSek + replay.endEnergyValueSek - planValue(replan.result)) < 0.15,
    `(${(replay.revenueSek + replay.endEnergyValueSek).toFixed(1)} vs ${planValue(replan.result).toFixed(1)} SEK)`
  );
}

// ---------- Holding on pays more (the owner lowered the hold margin): one window past its old end ----------
{
  const lowerMargin = nightInput(REPLAN_AT_MS, { socPercent: socAtReplan, knobs: { hold_margin_sek_per_kwh: 0.1 } });
  const before = afterPlanA();
  const running = activeOwnedEntries(before.ctx, REPLAN_AT_MS);
  const oldResult = generatePlan({
    ...lowerMargin,
    fixedBuys: [...lowerMargin.fixedBuys, ...ownedEntriesAsWindows(running.buying, "charging_power")],
  });
  applyPlan(before.ctx, oldResult.sells, oldResult.buys, running);
  check(
    "lower margin, old path: the morning is a second window chained to the frozen one",
    holdEntryEnd(before.config()) === NIGHT_END_MS &&
      before.config().scheduled_power_buying.schedule[new Date(NIGHT_END_MS).toISOString()]?.end_time ===
        new Date(MORNING_END_MS).toISOString(),
    `(${describeSchedule(before.config())})`
  );
  const after = afterPlanA();
  const replan = replanAroundRunningWindows(lowerMargin, activeOwnedEntries(after.ctx, REPLAN_AT_MS));
  applyPlan(after.ctx, replan.result.sells, replan.result.buys, replan.keepOwned);
  check(
    "lower margin, fixed: the running hold itself now holds to 09:00, one entry",
    holdEntryEnd(after.config()) === MORNING_END_MS &&
      !after.config().scheduled_power_buying.schedule[new Date(NIGHT_END_MS).toISOString()],
    `(${describeSchedule(after.config())})`
  );
}

// ---------- Nothing changed: the re-plan writes nothing (no churn every guard tick) ----------
{
  const trader = afterPlanA();
  const unchanged = nightInput(REPLAN_AT_MS, { socPercent: socAtReplan });
  const configBefore = trader.config();
  const replan = replanAroundRunningWindows(unchanged, activeOwnedEntries(trader.ctx, REPLAN_AT_MS));
  applyPlan(trader.ctx, replan.result.sells, replan.result.buys, replan.keepOwned);
  check(
    "nothing changed: the hold stays 22:00–06:00 and the config isn't rewritten",
    replan.result.runningHoldReshaped === true &&
      holdEntryEnd(trader.config()) === NIGHT_END_MS &&
      trader.config() === configBefore,
    `(${describeSchedule(trader.config())})`
  );
}

// ---------- A dear quarter right after the current one is bridged from the running hold ----------
{
  const blipAtMs = CURRENT_QUARTER_END_MS;
  const withBlip = (nowMs: number, knobs: Partial<PlannerInput["knobs"]> = {}, socPercent = 90) =>
    nightInput(nowMs, { blipAtMs, knobs, socPercent });
  const planWithBlip = generatePlan(withBlip(PLAN_AT_MS));
  const trader = scheduleHarness();
  applyPlan(trader.ctx, planWithBlip.sells, planWithBlip.buys);
  const running = activeOwnedEntries(trader.ctx, REPLAN_AT_MS);
  const soc = socAt(planWithBlip, REPLAN_AT_MS);
  const bridged = replanAroundRunningWindows(withBlip(REPLAN_AT_MS, {}, soc), running).result;
  const unbridged = replanAroundRunningWindows(withBlip(REPLAN_AT_MS, { hold_bridge_minutes: 0 }, soc), running).result;
  check(
    "dear 01:15 quarter: bridged from the current quarter, the hold runs on to 06:00",
    bridged.buys.some(window => window.hold && window.startMs === HOLD_START_MS && window.endMs === NIGHT_END_MS),
    `(13:00 plan ${describeWindows(planWithBlip.buys)}; re-plan ${describeWindows(bridged.buys)})`
  );
  check(
    "dear 01:15 quarter, no bridging: the hold ends at 01:15 and a new one starts after it",
    unbridged.buys.some(window => window.startMs === HOLD_START_MS && window.endMs === CURRENT_QUARTER_END_MS) &&
      unbridged.buys.some(window => window.hold && window.startMs === blipAtMs + 15 * MINUTE_MS),
    `(${describeWindows(unbridged.buys)})`
  );
}

// ---------- The minimum length doesn't cut the running hold's continuation, only new holds ----------
{
  const trader = afterPlanA();
  const lateReplanMs = testDayStartMs + 29 * HOUR_MS + 7 * MINUTE_MS;
  const longMinimum = nightInput(lateReplanMs, {
    socPercent: socAt(planA, lateReplanMs),
    knobs: { hold_min_window_minutes: 240 },
  });
  const fresh = generatePlan(longMinimum);
  const replan = replanAroundRunningWindows(longMinimum, activeOwnedEntries(trader.ctx, lateReplanMs));
  check(
    "05:07, a 240 min minimum: a fresh plan holds nothing tonight (05:00–06:00 is too short)",
    !fresh.buys.some(window => window.hold && window.startMs < NIGHT_END_MS),
    `(${describeWindows(fresh.buys)})`
  );
  check(
    "05:07, a 240 min minimum: the running hold still holds on to 06:00",
    replan.result.buys.some(window => window.hold && window.startMs === HOLD_START_MS && window.endMs === NIGHT_END_MS),
    `(${describeWindows(replan.result.buys)})`
  );
  check(
    "05:07, a 240 min minimum: new holds still need 4 h (tomorrow's 2 h night isn't held)",
    replan.result.buys.every(
      window => !window.hold || window.startMs === HOLD_START_MS || window.endMs - window.startMs >= 240 * MINUTE_MS
    ),
    `(${describeWindows(replan.result.buys)})`
  );
}

// ---------- Where nothing may change: as the old path, to the window ----------
{
  const trader = afterPlanA();
  const running = activeOwnedEntries(trader.ctx, REPLAN_AT_MS);
  const oldPath = (input: PlannerInput, entries: AutoTraderState["owned_entries"]) =>
    generatePlan({
      ...input,
      fixedSells: [...input.fixedSells, ...ownedEntriesAsWindows(entries.selling, "power_watts")],
      fixedBuys: [...input.fixedBuys, ...ownedEntriesAsWindows(entries.buying, "charging_power")],
    });
  const samePlan = (input: PlannerInput, entries: AutoTraderState["owned_entries"]) => {
    const replan = replanAroundRunningWindows(input, entries);
    return isDeepStrictEqual(replan.result, oldPath(input, entries)) && replan.keepOwned === entries;
  };
  check(
    "no expected spot (holds can't be valued): the running hold is planned around whole, as before",
    samePlan({ ...cheapEnergy, expectedSpot: undefined }, running)
  );
  check(
    "hold_enabled off: a running 100 W window is a charge, planned around whole, as before",
    samePlan({ ...cheapEnergy, knobs: { ...cheapEnergy.knobs, hold_enabled: false } }, running)
  );
  const runningSell: AutoTraderState["owned_entries"] = {
    selling: { [new Date(REPLAN_AT_MS - 7 * MINUTE_MS).toISOString()]: { end_time: hourIso(26), power_watts: 5000 } },
    buying: {},
  };
  const runningBuy: AutoTraderState["owned_entries"] = {
    selling: {},
    buying: {
      [new Date(REPLAN_AT_MS - 7 * MINUTE_MS).toISOString()]: { end_time: hourIso(27), charging_power: 10000 },
    },
  };
  check("a running sell window: planned around whole and kept, as before", samePlan(cheapEnergy, runningSell));
  check("a running 10 kW buy window: planned around whole and kept, as before", samePlan(cheapEnergy, runningBuy));
  check(
    "nothing running (daily, startup, manual): exactly the plan without running windows",
    samePlan(cheapEnergy, { selling: {}, buying: {} })
  );
}

finishSelftest();

/**
 * A 90 % battery, 600 W house, PV over the house 09:00–15:00 both days; the nights 22:00–06:00 at 0.3 SEK,
 * the evenings 17–21 at 2.0, the rest 1.3, published through the end of tomorrow; the terminal value on at
 * the given expected spot
 */
function nightInput(
  nowMs: number,
  {
    expectedSpot = 1.4,
    socPercent = 90,
    knobs = {},
    blipAtMs,
  }: { expectedSpot?: number; socPercent?: number; knobs?: Partial<PlannerInput["knobs"]>; blipAtMs?: number } = {}
): PlannerInput {
  return withTerminalValue(
    {
      nowMs,
      prices: mkPrices(48, hour => {
        const hourOfDay = hour % 24;
        if (blipAtMs !== undefined && testDayStartMs + hour * HOUR_MS === blipAtMs) return 1.6;
        if (hourOfDay >= 22 || hourOfDay < 6) return NIGHT_SPOT;
        if (hourOfDay >= 17 && hourOfDay < 21) return 2.0;
        return 1.3;
      }),
      solarWattsAt: ms => {
        const hourOfDay = ((ms - testDayStartMs) / HOUR_MS) % 24;
        return hourOfDay >= 9 && hourOfDay <= 15 ? 2000 : 0;
      },
      houseLoadWattsAt: () => 600,
      // The Ah ledger's idle draw, as live (~0 W): the inverter's own draw is in the hold's overhead and net DC-in
      parasiticWatts: 0,
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
        ...knobs,
      },
    },
    expectedSpot
  );
}

/** A trader whose schedule holds the 13:00 plan's windows, as ours */
function afterPlanA(): ReturnType<typeof scheduleHarness> {
  const trader = scheduleHarness();
  applyPlan(trader.ctx, planA.sells, planA.buys);
  return trader;
}

/** applyPlan and activeOwnedEntries on an in-memory config and trader state */
function scheduleHarness(): { ctx: ScheduleOwnershipContext; config: () => Config } {
  let config: Config = {
    ...default_config,
    scheduled_power_selling: { ...default_config.scheduled_power_selling, schedule: {} },
    scheduled_power_buying: { ...default_config.scheduled_power_buying, schedule: {} },
  };
  const state: AutoTraderState = { owned_entries: { selling: {}, buying: {} }, vetoes: [], forecast_log: {} };
  const setConfig = (update: (previous: Config) => Config) => {
    config = update(config);
  };
  return { ctx: { state, setConfig: setConfig as unknown as TraderCtx["setConfig"] }, config: () => config };
}

/** The SOC the plan projects at ms (after the last slot that ended by then): what the battery would read */
function socAt(plan: PlanResult, ms: number): number {
  const point = [...plan.socSeries].reverse().find(entry => entry.startMs + 15 * MINUTE_MS <= ms);
  return point?.socPercent ?? 90;
}

/** When the schedule's 22:00 hold entry ends, NaN when it's gone */
function holdEntryEnd(config: Config): number {
  const entry = config.scheduled_power_buying.schedule[HOLD_KEY];
  return entry ? +new Date(entry.end_time) : NaN;
}

function planValue(plan: PlanResult): number {
  return plan.projection.estimatedRevenueSek + (plan.projection.endEnergyValueSek ?? 0);
}

function hourIso(hour: number): string {
  return new Date(testDayStartMs + hour * HOUR_MS).toISOString();
}

function hoursOf(ms: number): string {
  return `${((ms - testDayStartMs) / HOUR_MS).toFixed(2)}h`;
}

function describeWindows(windows: PlannedWindow[]): string {
  return windows
    .map(
      window =>
        `${window.hold ? "hold" : window.kind} ${hoursOf(window.startMs)}→${hoursOf(window.endMs)}@${window.watts}`
    )
    .join(", ");
}

function describeSchedule(config: Config): string {
  return Object.entries(config.scheduled_power_buying.schedule)
    .map(([key, entry]) => `${hoursOf(+new Date(key))}→${hoursOf(+new Date(entry.end_time))}@${entry.charging_power}`)
    .join(", ");
}
