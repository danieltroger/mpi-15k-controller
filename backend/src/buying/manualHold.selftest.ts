/**
 * End-to-end self-test of a hold the user writes by hand, the way to charge the car from the grid without
 * cycling the battery: a ~100 W buy window over the charging hours, with hold_enabled on. Walks the chain:
 * the buy decision runs it as a hold (no SOC stop), the hold guard watches the breakers with the EV's 16 A per
 * phase on the inverter's output, the planner plans around it without retiming or removing it (and a re-plan
 * while it runs doesn't take it for a hold of ours), and the stuck-inverter alert stays quiet. Run from
 * backend/ with:
 *   yarn node src/buying/manualHold.selftest.ts
 */
import process from "process";
import { default_config } from "../config/config.ts";
import { decideScheduledBuy, wattsForInverter } from "./scheduledBuyDecision.ts";
import {
  dropOutAmps,
  type HoldGuardReadings,
  type HoldGuardSettings,
  type HoldGuardState,
  projectedHoldGridAmps,
  stepHoldWindowGuard,
} from "./holdWindowGuard.ts";
import { generatePlan } from "../autoTrading/planner.ts";
import { replanAroundRunningWindows } from "../autoTrading/replanAroundRunningWindows.ts";
import { activeOwnedEntries, applyPlan } from "../autoTrading/scheduleOwnership.ts";
import {
  baseKnobs,
  HOUR_MS,
  mkPrices,
  testDayStartMs,
  withTerminalValue,
} from "../autoTrading/plannerSelftestFixtures.ts";
import { evaluateDcSideIdle, type InverterStuckSnapshot } from "../alerting/inverterStuckDetection.ts";
import type { Config } from "../config/config.types.ts";
import type { AutoTraderState } from "../autoTrading/autoTraderState.types.ts";
import type { FixedWindow, PlannerInput } from "../autoTrading/planner.types.ts";
import type { TraderCtx } from "../autoTrading/traderContext.ts";

const failedChecks: string[] = [];
function check(name: string, passed: boolean, detail = "") {
  console.log(`${passed ? "PASS" : "FAIL"}: ${name} ${detail}`);
  if (!passed) failedChecks.push(name);
}

const MINUTE_MS = 60_000;
/** The car charging 22:00–06:00 on the house charger (the inverter's AC output), at 100 W */
const EV_WINDOW: FixedWindow = {
  startMs: testDayStartMs + 22 * HOUR_MS,
  endMs: testDayStartMs + 30 * HOUR_MS,
  watts: 100,
};
const EV_KEY = new Date(EV_WINDOW.startMs).toISOString();

// ---------- The runtime runs it as a hold: no SOC stop, the guard in charge ----------
{
  const gate = { only_buy_below_soc: 40, start_buying_again_below_soc: 15 };
  const fullBattery = decideScheduledBuy({
    ...gate,
    scheduledWattsPerWindow: [EV_WINDOW.watts],
    soc: 97,
    hitSocLimit: false,
    holdEnabled: true,
  });
  check(
    "hold on: the user's 100 W window at 97 % SOC is a hold, past the 40 % charging stop",
    fullBattery.holdWatts === 100 && fullBattery.chargingWatts === 0 && !fullBattery.hitSocLimit,
    `(${JSON.stringify(fullBattery)})`
  );
  check(
    "hold on: it reaches the inverter while the guard allows it, and not while it is out",
    wattsForInverter(fullBattery, true) === 100 && wattsForInverter(fullBattery, false) === 0
  );
  const holdOff = decideScheduledBuy({
    ...gate,
    scheduledWattsPerWindow: [EV_WINDOW.watts],
    soc: 97,
    hitSocLimit: false,
    holdEnabled: false,
  });
  check(
    "hold off: the same window is a charge the SOC stop ends (no guard, so leave hold on for the car)",
    holdOff.holdWatts === 0 && holdOff.chargingWatts === 0 && holdOff.hitSocLimit
  );
}

// ---------- The breaker guard with the EV at 16 A per phase on the inverter's output ----------
// Live: 22 A max grid draw, margin 2 A → out at 20 A, back below 18 A. The projection adds a third of the
// inverter's idle draw (the Ah ledger's, ~0 W), the hold's extra grid draw (170 W) and the trickle (100 W) to
// each phase.
const LIVE: HoldGuardSettings = {
  maxGridInputAmps: 22,
  gridMarginAmps: 2,
  reentryMinutes: 15,
  reentryHysteresisAmps: 2,
  minBatteryCelsius: 5,
};
const INVERTER_AND_TRICKLE_WATTS = 0 + 170 + 100;
const GRID_VOLTS = 235;
const KETTLE_WATTS = 2000;
{
  // The house's night base on its busiest phase, Sep–Oct 2026 quarter-hour means: 113 W median, 207 W p90
  const evAtNight = evReadings({ busiestPhaseBaseWatts: 207 });
  const evAndKettle = evReadings({ busiestPhaseBaseWatts: 207 + KETTLE_WATTS });
  const busiest = busiestPhaseAmps(evAtNight);
  check(
    "EV at 16 A with the night's p90 base projects ~17.3 A on its busiest phase: under 18 A, the hold runs",
    busiest > 17 && busiest < dropOutAmps(LIVE) - LIVE.reentryHysteresisAmps,
    `(${busiest.toFixed(1)} A)`
  );
  const night = runGuard([...repeatReading(evAtNight, 60 * 60)], LIVE);
  check(
    "an hour of EV charging at night keeps the hold",
    night.every(state => state.phase === "allowed")
  );
  const kettle = runGuard([...repeatReading(evAtNight, 60), ...repeatReading(evAndKettle, 180)], LIVE);
  const droppedAtSecond = kettle.findIndex(state => state.phase === "dropped_out");
  check(
    `a kettle on the EV's busiest phase (${busiestPhaseAmps(evAndKettle).toFixed(1)} A) ends the hold 5 s in: the battery takes house and car`,
    droppedAtSecond === 65,
    `(dropped out at second ${droppedAtSecond})`
  );
  const resumed = runGuard(
    [...repeatReading(evAtNight, 60), ...repeatReading(evAndKettle, 180), ...repeatReading(evAtNight, 20 * 60)],
    LIVE
  );
  const resumedAtSecond = resumed.findIndex((state, second) => second > 240 && state.phase === "allowed");
  check(
    "kettle off: the hold resumes 15 min later (the battery carried ~3.5 kWh of house and car meanwhile)",
    resumedAtSecond === 240 + 15 * 60,
    `(resumed at second ${resumedAtSecond})`
  );
  // A busier phase (fridge, router, lights: 450 W) puts the EV alone between the two levels
  const evBusyPhase = evReadings({ busiestPhaseBaseWatts: 450 });
  const stuckOut = runGuard(
    [...repeatReading(evBusyPhase, 60), ...repeatReading(evAndKettle, 180), ...repeatReading(evBusyPhase, 60 * 60)],
    LIVE
  );
  check(
    `the EV with 450 W on its phase (${busiestPhaseAmps(evBusyPhase).toFixed(1)} A) holds, but once out stays out: the battery charges the car`,
    stuckOut.slice(0, 60).every(state => state.phase === "allowed") &&
      stuckOut.slice(250).every(state => state.phase === "dropped_out")
  );
  // What gets the hold back in: the car at 13 A (Tesla app), a 20 A breaker's margin of 0 (out at 22 A), or a
  // narrower re-entry gap (hold_reentry_hysteresis_amps)
  const evAt13Amps = evReadings({ busiestPhaseBaseWatts: 450, evAmps: 13 });
  const evAt13AndKettle = evReadings({ busiestPhaseBaseWatts: 450 + KETTLE_WATTS, evAmps: 13 });
  check(
    "the car set to 13 A: back in 15 min after the kettle",
    runGuard(
      [...repeatReading(evAt13Amps, 60), ...repeatReading(evAt13AndKettle, 180), ...repeatReading(evAt13Amps, 16 * 60)],
      LIVE
    ).at(-1)?.phase === "allowed"
  );
  check(
    "margin 0 (out at 22 A, back below 20 A): back in 15 min after the kettle at 16 A",
    runGuard(
      [...repeatReading(evBusyPhase, 60), ...repeatReading(evAndKettle, 180), ...repeatReading(evBusyPhase, 16 * 60)],
      { ...LIVE, gridMarginAmps: 0 }
    ).at(-1)?.phase === "allowed"
  );
  check(
    "a 1 A re-entry gap (back below 19 A): back in 15 min after the kettle at 16 A, the breakers' level unchanged",
    runGuard(
      [...repeatReading(evBusyPhase, 60), ...repeatReading(evAndKettle, 180), ...repeatReading(evBusyPhase, 16 * 60)],
      { ...LIVE, reentryHysteresisAmps: 1 }
    ).at(-1)?.phase === "allowed"
  );
}

// ---------- The planner plans around it, as the user's: never retimed, removed or taken for ours ----------
{
  const input = eveningInput({ fixedBuys: [EV_WINDOW] });
  const plan = generatePlan(input);
  const overlapsEvWindow = (window: { startMs: number; endMs: number }) =>
    window.startMs < EV_WINDOW.endMs && window.endMs > EV_WINDOW.startMs;
  check(
    "the planner puts no sell or hold of its own into the user's window",
    !plan.sells.some(overlapsEvWindow) && !plan.buys.some(window => window.hold && overlapsEvWindow(window)),
    `(${[...plan.sells, ...plan.buys].map(window => `${window.kind} ${new Date(window.startMs).toISOString()}→${new Date(window.endMs).toISOString()}`).join(", ")})`
  );
  const socOverWindow = plan.socSeries.filter(
    point => point.startMs >= EV_WINDOW.startMs && point.startMs < EV_WINDOW.endMs
  );
  check(
    "it simulates the window as a hold: the battery keeps its energy through it",
    socOverWindow.length > 0 && socOverWindow.at(-1)!.socPercent >= socOverWindow[0].socPercent - 0.5,
    `(${socOverWindow[0]?.socPercent} % → ${socOverWindow.at(-1)?.socPercent} %)`
  );
  // Through the schedule: the user's entry survives the plan and a re-plan while it runs
  let config: Config = {
    ...default_config,
    scheduled_power_selling: { ...default_config.scheduled_power_selling, schedule: {} },
    scheduled_power_buying: {
      ...default_config.scheduled_power_buying,
      schedule: { [EV_KEY]: { end_time: new Date(EV_WINDOW.endMs).toISOString(), charging_power: EV_WINDOW.watts } },
    },
  };
  const state: AutoTraderState = { owned_entries: { selling: {}, buying: {} }, vetoes: [], forecast_log: {} };
  const ctx = {
    state,
    setConfig: ((update: (previous: Config) => Config) => {
      config = update(config);
    }) as unknown as TraderCtx["setConfig"],
  };
  applyPlan(ctx, plan.sells, plan.buys);
  const midnightMs = testDayStartMs + 24 * HOUR_MS + 7 * MINUTE_MS;
  const running = activeOwnedEntries(ctx, midnightMs);
  const replan = replanAroundRunningWindows(eveningInput({ nowMs: midnightMs, fixedBuys: [EV_WINDOW] }), running);
  applyPlan(ctx, replan.result.sells, replan.result.buys, replan.keepOwned);
  check(
    "a re-plan while it runs: not one of our running holds, nothing re-planned",
    !(EV_KEY in running.buying) && replan.result.runningHoldReshaped === undefined
  );
  check(
    "the user's entry is still exactly as written, and not ours",
    config.scheduled_power_buying.schedule[EV_KEY]?.end_time === new Date(EV_WINDOW.endMs).toISOString() &&
      config.scheduled_power_buying.schedule[EV_KEY]?.charging_power === EV_WINDOW.watts &&
      !(EV_KEY in ctx.state.owned_entries.buying)
  );
}

// ---------- The stuck-inverter alert: a quiet hold isn't a latch ----------
{
  // 2026-01-25's hold: the inverter reported 3 A Charging, the hall's minute means ran from −50 to +55 W
  const quietHold = (hallWatts: number) =>
    evaluateDcSideIdle(
      stuckSnapshot({ hallWatts, batteryAmps: 3, batteryDirection: "Charging", holdWindowInForce: true })
    ).observation;
  check(
    "a quiet hold the inverter reports charging is healthy, the hall at −50 W or +55 W alike",
    quietHold(-50) === "healthy" && quietHold(55) === "healthy"
  );
}

console.log(
  failedChecks.length ? `\n${failedChecks.length} FAILURES: ${failedChecks.join(", ")}` : "\nAll scenarios passed"
);
process.exit(failedChecks.length ? 1 : 0);

/** The hold guard's readings with the EV on all three phases and the house's base on the busiest one */
function evReadings({
  busiestPhaseBaseWatts,
  evAmps = 16,
}: {
  busiestPhaseBaseWatts: number;
  evAmps?: number;
}): HoldGuardReadings {
  const nowMs = 0;
  const reading = (value: number) => ({ value, time: nowMs });
  const evWatts = evAmps * GRID_VOLTS;
  return {
    grid: projectedHoldGridAmps({
      nowMs,
      activeWatts: { r: reading(evWatts + 60), s: reading(evWatts + 60), t: reading(evWatts + busiestPhaseBaseWatts) },
      apparentWatts: {},
      gridVolts: { r: reading(GRID_VOLTS), s: reading(GRID_VOLTS), t: reading(GRID_VOLTS) },
      inverterAndTrickleWatts: INVERTER_AND_TRICKLE_WATTS,
    }),
    coldestBatteryCelsius: 12,
  };
}

function busiestPhaseAmps(readings: HoldGuardReadings): number {
  if (readings.grid.status !== "ok") return NaN;
  return Math.max(readings.grid.ampsPerPhase.r, readings.grid.ampsPerPhase.s, readings.grid.ampsPerPhase.t);
}

function repeatReading(readings: HoldGuardReadings, seconds: number): HoldGuardReadings[] {
  return Array.from({ length: seconds }, () => readings);
}

/** Steps the guard once a second from "allowed" through the readings, a hold wanted throughout */
function runGuard(readingsPerSecond: HoldGuardReadings[], settings: HoldGuardSettings): HoldGuardState[] {
  let state: HoldGuardState = { phase: "allowed", overload: undefined };
  return readingsPerSecond.map((readings, second) => {
    state = stepHoldWindowGuard(state, { nowMs: second * 1000, holdWanted: true, readings }, settings).state;
    return state;
  });
}

/**
 * 18:00, an 80 % battery, a 600 W house, the night 22:00–06:00 at 0.3 SEK, the evening 17–21 at 2.0, the rest
 * 1.2, published through tomorrow; the terminal value and holds on
 */
function eveningInput({
  nowMs = testDayStartMs + 18 * HOUR_MS,
  fixedBuys,
}: {
  nowMs?: number;
  fixedBuys: FixedWindow[];
}): PlannerInput {
  return withTerminalValue(
    {
      nowMs,
      prices: mkPrices(48, hour => {
        const hourOfDay = hour % 24;
        if (hourOfDay >= 22 || hourOfDay < 6) return 0.3;
        if (hourOfDay >= 17 && hourOfDay < 21) return 2.0;
        return 1.2;
      }),
      solarWattsAt: ms => {
        const hourOfDay = ((ms - testDayStartMs) / HOUR_MS) % 24;
        return hourOfDay >= 9 && hourOfDay <= 15 ? 2000 : 0;
      },
      houseLoadWattsAt: () => 600,
      // The Ah ledger's idle draw, as live (~0 W)
      parasiticWatts: 0,
      socPercent: 80,
      capacityWh: 65000,
      constraintTailHours: 12,
      fixedSells: [],
      fixedBuys,
      sellVetoWindows: [],
      buyVetoWindows: [],
      knobs: {
        ...baseKnobs,
        allow_arbitrage_buying: true,
        fragmentation_tolerance_sek_per_window: 0.2,
        min_buy_saving_sek_per_kwh: 0.25,
        terminal_value_min_saving_sek_per_kwh: 1,
        hold_enabled: true,
      },
    },
    1.4
  );
}

/** A Rule B snapshot: fresh readings, the house on the grid, the pack at 53.5 V and 60 % */
function stuckSnapshot(values: {
  hallWatts: number;
  batteryAmps: number;
  batteryDirection: "Charging" | "Discharging" | "Idle";
  holdWindowInForce: boolean;
}): InverterStuckSnapshot {
  const nowMs = Date.now();
  const reading = <Value>(value: Value) => ({ value, time: nowMs - 500 });
  return {
    nowMs,
    inverter: {
      battery_current: reading(values.batteryAmps),
      battery_voltage: reading(53.5),
      battery_power_direction: reading(values.batteryDirection),
      "dc/ac_power_direction": reading(values.batteryDirection === "Idle" ? "Idle" : "AC to DC"),
      ac_input_total_active_power: reading(900),
    },
    smoothedHallWatts: { value: values.hallWatts, time: nowMs - 250 },
    averageSOC: 60,
    sunElevationDegrees: -20,
    commandedChargingAmps: 2,
    holdWindowInForce: values.holdWindowInForce,
    acChargingEnabledOnInverter: true,
  };
}
