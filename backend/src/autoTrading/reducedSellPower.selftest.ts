/**
 * Self-test of the greedy's reduced-power fallback (reducedSellPower.ts) on the 2026-10-29 08:07
 * incident. Run from backend/ with:
 *   yarn node src/autoTrading/reducedSellPower.selftest.ts
 *
 * The reserve floor binds at dawn tomorrow; 16:45 and 17:00 take most of the budget at full power and
 * the leftover fits no full evening quarter. The full-power-only greedy then rejected every evening
 * quarter and accepted the current slot (~7 min left, small enough at full power) at 1.49 SEK. With the
 * fallback the leftover goes to the best remaining evening quarter instead — and, with a minimum window
 * longer than one quarter, to one that can still make a window, rather than a lone quarter the minimum
 * would drop together with its budget.
 */
import { generatePlan, SLOT_MS } from "./planner.ts";
import { baseKnobs, check, finishSelftest, HOUR_MS, mkPrices, testDayStartMs } from "./plannerSelftestFixtures.ts";
import type { PlannedWindow, PlannerInput, PlanResult } from "./planner.types.ts";

const EVENING_SPOTS_BY_HOUR = new Map([
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
const CURRENT_SLOT_START_MS = testDayStartMs + 8 * HOUR_MS;

// Full power only: min_sell_power_watts at the full sell power switches the fallback off (the old greedy)
const fullPowerOnly = generatePlan(incidentInput({ minSellPowerWatts: 15000, minWindowMinutes: 15 }));
const withFallback = generatePlan(incidentInput({ minSellPowerWatts: 1500, minWindowMinutes: 15 }));
check(
  "leftover: full-power-only greedy reproduces the incident (sells the current partial slot)",
  sellsInCurrentSlot(fullPowerOnly).length === 1,
  describeSells(fullPowerOnly)
);
check(
  "leftover: with the fallback nothing is sold in the current slot",
  sellsInCurrentSlot(withFallback).length === 0,
  describeSells(withFallback)
);
check(
  "leftover: sold at reduced power in an evening quarter",
  withFallback.sells.some(window => window.watts < 15000 && window.watts >= 1500 && window.avgSpot >= 2.2),
  describeSells(withFallback)
);
check(
  "leftover: every sell is in the evening peak",
  withFallback.sells.every(window => window.avgSpot >= 2.2),
  describeSells(withFallback)
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

// With a 30-min minimum window the lone 16:15 quarter the fallback picks above would be dropped at
// merge time, budget and all. The leftover must go where it survives the minimum.
const fullPowerOnly30 = generatePlan(incidentInput({ minSellPowerWatts: 15000, minWindowMinutes: 30 }));
const withFallback30 = generatePlan(incidentInput({ minSellPowerWatts: 1500, minWindowMinutes: 30 }));
check(
  "min window 30: no window was dropped for being short",
  !withFallback30.notes.some(note => note.startsWith("Dropped")),
  `(${withFallback30.notes.join(" | ")})`
);
check(
  "min window 30: every sell chain lasts at least 30 min",
  sellChainMinutes(withFallback30.sells).every(minutes => minutes >= 30),
  describeSells(withFallback30)
);
check(
  "min window 30: the leftover is still sold at reduced power",
  withFallback30.sells.some(window => window.watts < 15000),
  describeSells(withFallback30)
);
check(
  "min window 30: sells no less than without the fallback",
  withFallback30.projection.plannedSellKwh >= fullPowerOnly30.projection.plannedSellKwh &&
    withFallback30.projection.estimatedRevenueSek >= fullPowerOnly30.projection.estimatedRevenueSek,
  `(${withFallback30.projection.plannedSellKwh} vs ${fullPowerOnly30.projection.plannedSellKwh} kWh, ${withFallback30.projection.estimatedRevenueSek} vs ${fullPowerOnly30.projection.estimatedRevenueSek} SEK)`
);
check(
  "min window 30: floor respected",
  withFallback30.projection.minSocPercent >= 6.95,
  `(min SOC ${withFallback30.projection.minSocPercent}%)`
);
console.log("  full power only:      ", describeSells(fullPowerOnly));
console.log("  with fallback:        ", describeSells(withFallback));
console.log("  full power only, 30 m:", describeSells(fullPowerOnly30));
console.log("  with fallback, 30 m:  ", describeSells(withFallback30));

finishSelftest();

/** 2026-10-29 at 08:07:39 (~7.4 min of the 08:00 slot left), with that day's live knobs */
function incidentInput({
  minSellPowerWatts,
  minWindowMinutes,
}: {
  minSellPowerWatts: number;
  minWindowMinutes: number;
}): PlannerInput {
  return {
    nowMs: CURRENT_SLOT_START_MS + 7.65 * 60_000,
    prices: mkPrices(24, incidentSpotAtHour),
    solarWattsAt: autumnSunWatts,
    houseLoadWattsAt: () => 600,
    parasiticWatts: 230,
    socPercent: 27.5,
    capacityWh: 65000,
    constraintTailHours: 18,
    fixedSells: [],
    fixedBuys: [],
    sellVetoWindows: [],
    buyVetoWindows: [],
    knobs: {
      ...baseKnobs,
      min_sell_power_watts: minSellPowerWatts,
      min_window_minutes: minWindowMinutes,
      planner_soc_floor_percent: 7,
      planner_soc_floor_sunny_percent: 3,
      runtime_soc_floor_percent: 5,
      emergency_soc_floor_percent: 0,
      min_sell_spot_sek_per_kwh: 0.8,
      min_gain_sek_per_slot: 0.5,
      sell_ramp_minutes: 10,
      fragmentation_tolerance_sek_per_window: 0.2,
    },
  };
}

function incidentSpotAtHour(hour: number): number {
  const eveningSpot = EVENING_SPOTS_BY_HOUR.get(hour);
  if (eveningSpot !== undefined) return eveningSpot;
  if (hour >= 8 && hour < 8.25) return 1.49; // the current slot
  if (hour >= 18.25 && hour < 20) return 1.9;
  if (hour >= 15 && hour < 16) return 1.7;
  return 1.2;
}

function autumnSunWatts(ms: number): number {
  const hourOfDay = ((ms - testDayStartMs) / HOUR_MS) % 24;
  return hourOfDay >= 7 && hourOfDay <= 15 ? Math.sin(((hourOfDay - 7) / 8) * Math.PI) * 4500 : 0;
}

/** Windows that sell in the current slot (keyed at the next whole minute after the plan, not the slot's start) */
function sellsInCurrentSlot(plan: PlanResult): PlannedWindow[] {
  return plan.sells.filter(
    window => window.startMs < CURRENT_SLOT_START_MS + SLOT_MS && window.endMs > CURRENT_SLOT_START_MS
  );
}

/** Lengths of the time-contiguous chains the windows form (a power step splits a window, not a chain) */
function sellChainMinutes(sells: PlannedWindow[]): number[] {
  const chains: { startMs: number; endMs: number }[] = [];
  for (const window of [...sells].sort((earlier, later) => earlier.startMs - later.startMs)) {
    const lastChain = chains[chains.length - 1];
    if (lastChain && lastChain.endMs === window.startMs) lastChain.endMs = window.endMs;
    else chains.push({ startMs: window.startMs, endMs: window.endMs });
  }
  return chains.map(chain => (chain.endMs - chain.startMs) / 60_000);
}

function describeSells(plan: PlanResult): string {
  return `(${plan.sells
    .map(
      window =>
        `h${(window.startMs - testDayStartMs) / HOUR_MS}-h${(window.endMs - testDayStartMs) / HOUR_MS}@${window.watts}W/${window.avgSpot.toFixed(2)}`
    )
    .join(", ")})`;
}
