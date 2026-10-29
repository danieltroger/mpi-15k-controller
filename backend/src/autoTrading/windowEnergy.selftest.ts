/**
 * Self-test of a planned sell window's expected energy (planWindows.ts toPlanned's expectedKwh): it is
 * what the plan's simulation exports in the window's slots, the feed-in ramp included, so the window
 * text's "~N kWh", the dashboard's per-window estimate and the planned_sell_kwh that settlement
 * compares against reality (tradingPerformance.ts) all agree with the projection. Run from backend/ with:
 *   yarn node src/autoTrading/windowEnergy.selftest.ts
 */
import { generatePlan } from "./planner.ts";
import { rampedSlotExport, sellRampWattsPerMinute } from "./feedInRamp.ts";
import { captureForecastLog, localDateStr } from "./tradingPerformance.ts";
import { EMPTY_STATE } from "./autoTraderState.ts";
import { baseKnobs, check, finishSelftest, HOUR_MS, mkPrices, testDayStartMs } from "./plannerSelftestFixtures.ts";
import type { PlannedWindow, PlannerInput, PlannerKnobs } from "./planner.types.ts";

const RAMP_KNOBS: PlannerKnobs = {
  ...baseKnobs,
  sell_ramp_minutes: 10,
  planner_soc_floor_percent: 7,
  planner_soc_floor_sunny_percent: 3,
  runtime_soc_floor_percent: 5,
  emergency_soc_floor_percent: 0,
  min_gain_sek_per_slot: 0.5,
  min_window_minutes: 15,
};

// ---------- A window in the current slot: the incident's 7-min sell ----------
// 2026-10-29 08:07:39: a 15 kW window in the 7.35 min left of the slot. The text said "~2 kWh"
// (14.4 kW × 7.35 min); the feed only ramps to 11 kW by the slot's end, 0.675 kWh.
{
  const planAtMs = testDayStartMs + 8 * HOUR_MS + 7 * 60_000 + 39_000;
  const plan = generatePlan(
    plannerInput({
      nowMs: planAtMs,
      socPercent: 90,
      // Only the current slot is worth selling
      prices: mkPrices(24, hour => (hour >= 8 && hour < 8.25 ? 3.0 : 0.05)),
    })
  );
  const window = plan.sells[0];
  const rampedWh = rampedSlotExport(0, 14400, 7.35, sellRampWattsPerMinute(RAMP_KNOBS)).averageW * (7.35 / 60);
  check(
    "current slot: the window's energy is the ramped export, not power × time",
    plan.sells.length === 1 && Math.abs(window.expectedKwh * 1000 - rampedWh) < 1,
    `(${window?.expectedKwh.toFixed(3)} kWh vs the ramp's ${(rampedWh / 1000).toFixed(3)} kWh; power × time would be 1.764 kWh)`
  );
  check(
    "current slot: the window text quotes it to a tenth",
    !!window?.reason.includes("~0.7 kWh"),
    `(${window?.reason})`
  );
}

// ---------- The windows add up to the projection, which settlement records ----------
// Tomorrow evening's peak, planned at 13:00 today: two separate windows, each starting from rest
// (~1.2 kWh of ramp each at 14.4 kW). Their expected energies sum to the projection's planned sell
// energy, and that sum is the planned_sell_kwh settlement later scores against the measured export.
{
  const nowMs = testDayStartMs + 13 * HOUR_MS;
  // A full battery and no reserve tail leave the budget to sell both windows in full
  const input = plannerInput({
    nowMs,
    socPercent: 100,
    constraintTailHours: 0,
    prices: mkPrices(48, hour => {
      if (hour >= 41 && hour < 41.5) return 3.0;
      if (hour >= 42 && hour < 42.5) return 2.9;
      return 0.05;
    }),
  });
  const plan = generatePlan(input);
  const windowsKwh = plan.sells.reduce((sum, window) => sum + window.expectedKwh, 0);
  check(
    "sum: separate windows, each with its ramp, add up to the projection's planned sell energy",
    plan.sells.length === 2 && Math.abs(windowsKwh - plan.projection.plannedSellKwh) <= 0.05,
    `(${describeWindows(plan.sells)}: ${windowsKwh.toFixed(2)} kWh vs ${plan.projection.plannedSellKwh} kWh projected)`
  );

  const state = structuredClone(EMPTY_STATE);
  captureForecastLog(state, input, plan.sells);
  const tomorrow = localDateStr(testDayStartMs + 41 * HOUR_MS);
  const plannedSellKwh = state.forecast_log[tomorrow]?.planned_sell_kwh;
  check(
    "settlement: tomorrow's planned_sell_kwh is the projected export of tomorrow's windows",
    plannedSellKwh !== undefined && Math.abs(plannedSellKwh - plan.projection.plannedSellKwh) <= 0.05,
    `(${plannedSellKwh} kWh vs ${plan.projection.plannedSellKwh} kWh projected)`
  );
}

finishSelftest();

/** No sun, 600 W of house load, nothing fixed */
function plannerInput(
  overrides: Partial<PlannerInput> & Pick<PlannerInput, "nowMs" | "socPercent" | "prices">
): PlannerInput {
  return {
    solarWattsAt: () => 0,
    houseLoadWattsAt: () => 600,
    parasiticWatts: 230,
    capacityWh: 65000,
    constraintTailHours: 8,
    fixedSells: [],
    fixedBuys: [],
    sellVetoWindows: [],
    buyVetoWindows: [],
    knobs: RAMP_KNOBS,
    ...overrides,
  };
}

function describeWindows(sells: PlannedWindow[]): string {
  return sells
    .map(
      window =>
        `h${(window.startMs - testDayStartMs) / HOUR_MS}-h${(window.endMs - testDayStartMs) / HOUR_MS}@${window.watts}W ~${window.expectedKwh.toFixed(2)} kWh`
    )
    .join(", ");
}
