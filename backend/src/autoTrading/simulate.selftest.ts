/**
 * Self-test of the feed-in ramp as the simulation models it (feedInRamp.ts): a rate, also for mid-run
 * step-ups, an immediate step-down, a sell that climbs from the baseline feed, and slot 0 of a plan made
 * while a window is already running starting where that window has got to. Run from backend/ with:
 *   yarn node src/autoTrading/simulate.selftest.ts
 */
import { buildSlots, generatePlan, projectWithFixedWindows, SLOT_MS } from "./planner.ts";
import { simulate } from "./simulate.ts";
import { feedInReachedAtNow, rampedSlotExport, sellRampWattsPerMinute } from "./feedInRamp.ts";
import { baseKnobs, check, finishSelftest, HOUR_MS, mkPrices, testDayStartMs } from "./plannerSelftestFixtures.ts";
import type { FixedWindow, PlannedWindow, PlannerInput, Slot } from "./planner.types.ts";

const RAMP_KNOBS = { ...baseKnobs, sell_ramp_minutes: 10 }; // 15 kW / 10 min = 1.5 kW/min
const RAMP_WATTS_PER_MINUTE = sellRampWattsPerMinute(RAMP_KNOBS);

// ---------- The ramp is a rate, also for mid-run step-ups ----------
// Measured ~1.4 kW/min whatever the target: a 5 kW target is reached in ~3.5 min, and a 5 → 15 kW
// step-up mid-run climbs for ~7 min (2026-09-14). Decreases are immediate.
{
  // 0 → 5 kW in 3.33 min, then 11.67 min held: (2.5 kW × 3.33 + 5 kW × 11.67) / 60 = 1111 Wh.
  // The old model stretched every start over the full 10 min whatever the target: 833 Wh.
  const fiveKwQuarterWh = exportedWh([5000, 0, 0], { pvW: 2000 });
  check(
    "ramp rate: a 5 kW window delivers more in its first quarter than the old 10-min model",
    Math.abs(fiveKwQuarterWh - 1111.1) < 1 && fiveKwQuarterWh > 833.3 + 200,
    `(${fiveKwQuarterWh.toFixed(1)} Wh, old model 833.3 Wh)`
  );
  // 5 → 15 kW climbs for 6.67 min: (10 kW × 6.67 + 15 kW × 8.33) / 60 = 3194 Wh, not a full 3750 Wh
  const stepUpQuarterWh = exportedWh([5000, 15000, 0], { pvW: 2000 }) - fiveKwQuarterWh;
  check(
    "ramp rate: a mid-run step-up ramps",
    Math.abs(stepUpQuarterWh - 3194.4) < 1,
    `(${stepUpQuarterWh.toFixed(1)} Wh, full power would be 3750 Wh)`
  );
  const stepDownQuarterWh = exportedWh([15000, 5000, 0], { pvW: 2000 }) - exportedWh([15000, 0, 0], { pvW: 2000 });
  check(
    "ramp rate: a step-down is immediate",
    Math.abs(stepDownQuarterWh - 1250) < 1,
    `(${stepDownQuarterWh.toFixed(1)} Wh)`
  );
  // The 2026-10-29 08:07:40 start: ~7.3 min left of the slot at 15 kW never gets past ~11 kW
  const partialSlot = rampedSlotExport(0, 15000, 7.35, RAMP_WATTS_PER_MINUTE);
  check(
    "ramp rate: a short slot ends mid-ramp",
    Math.abs(partialSlot.endW - 11025) < 1 && Math.abs(partialSlot.averageW - 5512.5) < 1,
    `(end ${partialSlot.endW} W, average ${partialSlot.averageW} W)`
  );
}

// ---------- A sell after a baseline-feed slot climbs from the baseline ----------
{
  // Without sun the slot before feeds the 350 W baseline: 350 → 5000 W in 3.1 min, then held,
  // (2675 W × 3.1 + 5000 W × 11.9) / 60 = 1129.9 Wh (from 0 it would be 1111.1 Wh)
  const afterBaselineWh = exportedWh([0, 5000, 0], { pvW: 0 });
  check(
    "baseline: a sell after the baseline feed climbs from 350 W",
    Math.abs(afterBaselineWh - 1129.9) < 1,
    `(${afterBaselineWh.toFixed(1)} Wh)`
  );
}

// ---------- How far a running window has got at "now" ----------
{
  const windowStartMs = testDayStartMs + 16.75 * HOUR_MS;
  const fullPowerWindow: FixedWindow = { startMs: windowStartMs, endMs: windowStartMs + 2 * SLOT_MS, watts: 15000 };
  const sevenMinutesIn = windowStartMs + 7 * 60_000;
  check(
    "running window: 7 min into a 15 kW window the feed is at 10.5 kW",
    Math.abs(feedInReachedAtNow([fullPowerWindow], sevenMinutesIn, 15000, RAMP_WATTS_PER_MINUTE) - 10500) < 1
  );
  check(
    "running window: the house load caps it like it caps export",
    Math.abs(feedInReachedAtNow([fullPowerWindow], windowStartMs + 20 * 60_000, 14400, RAMP_WATTS_PER_MINUTE) - 14400) <
      1
  );
  check(
    "running window: nothing feeds before the window starts or after it ends",
    feedInReachedAtNow([fullPowerWindow], windowStartMs - 1, 15000, RAMP_WATTS_PER_MINUTE) === 0 &&
      feedInReachedAtNow([fullPowerWindow], fullPowerWindow.endMs, 15000, RAMP_WATTS_PER_MINUTE) === 0
  );
  // A 5 kW window ran 16:30–16:45 (reached 5 kW after 3.3 min), then 15 kW from 16:45: 7 min of
  // climbing from 5 kW reaches 15.5 kW, capped at the target
  const leadIn: FixedWindow = { startMs: windowStartMs - SLOT_MS, endMs: windowStartMs, watts: 5000 };
  const chained = feedInReachedAtNow([fullPowerWindow, leadIn], sevenMinutesIn, 15000, RAMP_WATTS_PER_MINUTE);
  check(
    "running window: an adjacent earlier window keeps the ramp going",
    Math.abs(chained - 15000) < 1,
    `(${chained} W)`
  );
  const threeMinutesIn = feedInReachedAtNow(
    [leadIn, fullPowerWindow],
    windowStartMs + 3 * 60_000,
    15000,
    RAMP_WATTS_PER_MINUTE
  );
  check(
    "running window: a step-up climbs from the lead-in's level",
    Math.abs(threeMinutesIn - 9500) < 1,
    `(${threeMinutesIn} W, 5000 + 3 min × 1500)`
  );
  const gapped: FixedWindow = { ...leadIn, startMs: leadIn.startMs - SLOT_MS, endMs: leadIn.startMs };
  const afterGap = feedInReachedAtNow([gapped, fullPowerWindow], sevenMinutesIn, 15000, RAMP_WATTS_PER_MINUTE);
  check("running window: a gap restarts the ramp", Math.abs(afterGap - 10500) < 1, `(${afterGap} W)`);
}

// ---------- A plan made mid-window sees the window's real drain (PR #77 review) ----------
// Re-plans happen while windows run (the opportunistic replan every 30 min, the guard's re-plan).
// Ramping the running 15 kW window from 0 again at "now" under-credits it by up to ~1.25 kWh, which
// the planner then sold as spare budget. A plan made 7 min into the window, from the SOC those
// 7 min left, must project the same schedule like the plan made at the window's start, and must not
// find more to sell.
{
  const runningWindow: FixedWindow = {
    startMs: testDayStartMs + 16.75 * HOUR_MS,
    endMs: testDayStartMs + 17.25 * HOUR_MS,
    watts: 15000,
  };
  const atWindowStart = midWindowInput(runningWindow.startMs, 55, runningWindow);
  // The first 7 min: export ramps 0 → 10.5 kW (average 5.25 kW), the house and the inverter draw
  // 830 W, all from the battery at 93 %: (612.5 + 96.8) Wh / 0.93 = 762.7 Wh = 1.173 pp of 65 kWh
  const socSevenMinutesIn = 55 - (((5250 + 830) * (7 / 60)) / 0.93 / 65000) * 100;
  const sevenMinutesIn = midWindowInput(runningWindow.startMs + 7 * 60_000, socSevenMinutesIn, runningWindow);

  const projectionAtStart = projectWithFixedWindows(atWindowStart);
  const projectionMidWindow = projectWithFixedWindows(sevenMinutesIn);
  check(
    "mid-window: the projection lands where the one from the window's start does",
    Math.abs(projectionMidWindow.endSocPercent - projectionAtStart.endSocPercent) <= 0.1,
    `(end SOC ${projectionMidWindow.endSocPercent}% vs ${projectionAtStart.endSocPercent}%)`
  );
  const planAtStart = generatePlan(atWindowStart);
  const planMidWindow = generatePlan(sevenMinutesIn);
  check(
    "mid-window: the plan made 7 min in sells no more than the one made at the start",
    plannedSetpointKwh(planMidWindow.sells) <= plannedSetpointKwh(planAtStart.sells) + 0.05,
    `(${plannedSetpointKwh(planMidWindow.sells).toFixed(2)} vs ${plannedSetpointKwh(planAtStart.sells).toFixed(2)} kWh of new windows)`
  );
  check(
    "mid-window: both plans keep the floor",
    planAtStart.projection.minSocPercent >= 6.95 && planMidWindow.projection.minSocPercent >= 6.95,
    `(${planAtStart.projection.minSocPercent}% / ${planMidWindow.projection.minSocPercent}%)`
  );
}

// ---------- The runtime schedule seeds the ramp for a window the plan rewrites ----------
// The daily run may replace a running window of ours (it isn't among fixedSells then). If the new
// plan sells in that slot too, the inverter just keeps feeding: 7 min into a 15 kW window, the 8 min
// left of the slot climb from 10.5 kW and average (12.75 kW × 3 + 15 kW × 5) / 8 = 14.16 kW
// (1887.5 Wh), not 0 → 12 kW (800 Wh).
{
  const runningWindow: FixedWindow = {
    startMs: testDayStartMs + 16.75 * HOUR_MS,
    endMs: testDayStartMs + 17.25 * HOUR_MS,
    watts: 15000,
  };
  const nowMs = runningWindow.startMs + 7 * 60_000;
  const knownSchedule = slotZeroExportWh(nowMs, [runningWindow]);
  const unknownSchedule = slotZeroExportWh(nowMs, []);
  check(
    "rewritten window: a new sell in the running slot continues the feed",
    Math.abs(knownSchedule - 1887.5) < 1 && Math.abs(unknownSchedule - 800) < 1,
    `(${knownSchedule.toFixed(1)} Wh with the schedule, ${unknownSchedule.toFixed(1)} Wh without)`
  );
}

// ---------- A window the plan starts in the current slot is keyed when it starts feeding ----------
// PR #77 re-review: keyed at the slot's start (16:45 for a plan at 16:52), every projection after the
// apply seeded the window with ~7 min of ramp it never had (~0.9 kWh), and a guard tick in the next
// minutes saw a breach that wasn't there, re-planned and shed sells. Keyed at the next whole minute,
// where the runtime starts feeding it, a guard projection right after the apply agrees with the plan.
{
  const planAtMs = testDayStartMs + 16.75 * HOUR_MS + 7 * 60_000 + 39_000; // 16:52:39
  const peakNowInput: PlannerInput = {
    nowMs: planAtMs,
    prices: mkPrices(24, hour => (hour >= 16.75 && hour < 17.25 ? 3.0 : 0.5)),
    solarWattsAt: () => 0,
    houseLoadWattsAt: () => 600,
    parasiticWatts: 230,
    socPercent: 40,
    capacityWh: 65000,
    constraintTailHours: 8,
    fixedSells: [],
    fixedBuys: [],
    sellVetoWindows: [],
    buyVetoWindows: [],
    knobs: {
      ...RAMP_KNOBS,
      planner_soc_floor_percent: 7,
      planner_soc_floor_sunny_percent: 3,
      runtime_soc_floor_percent: 5,
      emergency_soc_floor_percent: 0,
      min_gain_sek_per_slot: 0.5,
      min_window_minutes: 15,
      fragmentation_tolerance_sek_per_window: 0.2,
    },
  };
  const plan = generatePlan(peakNowInput);
  const currentSlotStartMs = testDayStartMs + 16.75 * HOUR_MS;
  const currentSlotWindow = plan.sells.find(
    window => window.startMs >= currentSlotStartMs && window.startMs < currentSlotStartMs + SLOT_MS
  );
  check(
    "current-slot key: the window starts at the next whole minute after the plan",
    currentSlotWindow?.startMs === currentSlotStartMs + 8 * 60_000,
    `(${plan.sells.map(window => new Date(window.startMs).toISOString()).join(", ")})`
  );
  // The guard as runGuard builds it: the applied windows are our owned entries, now part of the
  // runtime's schedule; nothing has fed yet, so the SOC is still the plan's
  const appliedWindows = plan.sells.map(window => ({
    startMs: window.startMs,
    endMs: window.endMs,
    watts: window.watts,
  }));
  for (const secondsAfterPlan of [0, 30, 90]) {
    const guardProjection = projectWithFixedWindows({
      ...peakNowInput,
      nowMs: planAtMs + secondsAfterPlan * 1000,
      fixedSells: appliedWindows,
      runningSellSchedule: appliedWindows,
    });
    check(
      `current-slot key: a guard ${secondsAfterPlan} s after the apply sees no breach the plan didn't`,
      guardProjection.violationWh <= 1 && guardProjection.minSocPercent >= plan.projection.minSocPercent - 0.05,
      `(violation ${Math.round(guardProjection.violationWh)} Wh, min SOC ${guardProjection.minSocPercent}% vs the plan's ${plan.projection.minSocPercent}%)`
    );
  }
}

finishSelftest();

/** Export (Wh) of three quarters of selling at the given setpoints, from a 90 % battery */
function exportedWh(sellWatts: number[], { pvW }: { pvW: number }): number {
  const quarterSlots: Slot[] = sellWatts.map((_, index) => ({
    startMs: testDayStartMs + index * SLOT_MS,
    endMs: testDayStartMs + (index + 1) * SLOT_MS,
    durationH: 0.25,
    spot: 1,
    pvW,
    houseW: 0,
    fixedSellW: 0,
    fixedBuyW: 0,
    feedInAtStartW: 0,
  }));
  const rampInput: PlannerInput = {
    nowMs: testDayStartMs,
    prices: [],
    solarWattsAt: () => pvW,
    houseLoadWattsAt: () => 0,
    parasiticWatts: 0,
    socPercent: 90,
    capacityWh: 65000,
    constraintTailHours: 0,
    fixedSells: [],
    fixedBuys: [],
    sellVetoWindows: [],
    buyVetoWindows: [],
    knobs: RAMP_KNOBS,
  };
  return simulate(rampInput, quarterSlots, sellWatts, new Array(sellWatts.length).fill(0), 1).sellExportWh;
}

/** Export (Wh) of a new 15 kW sell in the 8 min left of the current slot, given the runtime's schedule */
function slotZeroExportWh(nowMs: number, runningSellSchedule: FixedWindow[]): number {
  const input: PlannerInput = {
    nowMs,
    prices: mkPrices(24, () => 2),
    solarWattsAt: () => 0,
    houseLoadWattsAt: () => 0,
    parasiticWatts: 0,
    socPercent: 90,
    capacityWh: 65000,
    constraintTailHours: 0,
    fixedSells: [],
    runningSellSchedule,
    fixedBuys: [],
    sellVetoWindows: [],
    buyVetoWindows: [],
    knobs: RAMP_KNOBS,
  };
  const slots = buildSlots(input);
  const sellWatts = slots.map((_, slotIndex) => (slotIndex === 0 ? 15000 : 0));
  return simulate(input, slots, sellWatts, new Array(slots.length).fill(0), 1).sellExportWh;
}

/** An evening with a running 15 kW window (kept fixed, like the trader keeps an active one) */
function midWindowInput(nowMs: number, socPercent: number, runningWindow: FixedWindow): PlannerInput {
  return {
    nowMs,
    prices: mkPrices(24, hour => (hour >= 16.75 && hour < 17.25 ? 3.0 : hour >= 17.25 && hour < 20 ? 2.0 : 0.5)),
    solarWattsAt: () => 0,
    houseLoadWattsAt: () => 600,
    parasiticWatts: 230,
    socPercent,
    capacityWh: 65000,
    constraintTailHours: 8,
    fixedSells: [runningWindow],
    fixedBuys: [],
    sellVetoWindows: [],
    buyVetoWindows: [],
    knobs: {
      ...RAMP_KNOBS,
      planner_soc_floor_percent: 7,
      planner_soc_floor_sunny_percent: 3,
      runtime_soc_floor_percent: 5,
      emergency_soc_floor_percent: 0,
      min_gain_sek_per_slot: 0.5,
      min_window_minutes: 15,
      fragmentation_tolerance_sek_per_window: 0.2,
    },
  };
}

/** Energy the new windows ask for at their setpoints (kWh) — the ramp aside, what a plan commits to */
function plannedSetpointKwh(sells: PlannedWindow[]): number {
  return sells.reduce((sum, window) => sum + (window.watts * (window.endMs - window.startMs)) / HOUR_MS / 1000, 0);
}
