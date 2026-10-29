/**
 * Self-test of how a plan treats the sell feed already running at "now": slot 0 starts from the
 * inverter's measured feed-in where the schedule misstates it (feedInRamp.ts runningFeedAtNow,
 * measuredFeedIn.ts), and a new window that continues the running one is keyed where that one started
 * (planWindows.ts sellWindowStartMs). Both follow up PR #77's review. Run from backend/ with:
 *   yarn node src/autoTrading/runningFeed.selftest.ts
 */
import { buildSlots, generatePlan, projectWithFixedWindows } from "./planner.ts";
import { freshMeasuredFeedInW, MEASURED_FEED_IN_MAX_AGE_MS } from "./measuredFeedIn.ts";
import { baseKnobs, check, finishSelftest, HOUR_MS, mkPrices, testDayStartMs } from "./plannerSelftestFixtures.ts";
import type { FixedWindow, PlannedWindow, PlannerInput, PlannerKnobs } from "./planner.types.ts";

// The live knobs' shape: floor 7 / sunny 3, 15-min windows, 10-min ramp (1.5 kW/min)
const LIVE_LIKE_KNOBS: PlannerKnobs = {
  ...baseKnobs,
  sell_ramp_minutes: 10,
  planner_soc_floor_percent: 7,
  planner_soc_floor_sunny_percent: 3,
  runtime_soc_floor_percent: 5,
  emergency_soc_floor_percent: 0,
  min_gain_sek_per_slot: 0.5,
  min_window_minutes: 15,
  fragmentation_tolerance_sek_per_window: 0.2,
};
// 600 W of house load leaves 14.4 kW of the 15 kW rating to export
const EXPORT_CAP_W = 14400;

// ---------- The trader's reading: fresh, finite, negative while feeding ----------
{
  const nowMs = testDayStartMs + 17 * HOUR_MS;
  check(
    "reading: a fresh export reading is the measured feed-in",
    freshMeasuredFeedInW({ value: -12345, time: nowMs - 2000 }, nowMs) === 12345
  );
  check(
    "reading: importing from the grid measures no feed-in",
    freshMeasuredFeedInW({ value: 800, time: nowMs - 2000 }, nowMs) === 0
  );
  check(
    "reading: a stale or missing reading measures nothing, so the schedule replay takes over",
    freshMeasuredFeedInW({ value: -12345, time: nowMs - MEASURED_FEED_IN_MAX_AGE_MS - 1 }, nowMs) === undefined &&
      freshMeasuredFeedInW(undefined, nowMs) === undefined &&
      freshMeasuredFeedInW({ value: NaN, time: nowMs }, nowMs) === undefined
  );
}

// ---------- The chain-history gap: a running window's earlier link is gone from the schedule ----------
// An opportunistic replan at 16:52 kept the running 16:45–17:00 @ 15 kW window and added 17:00–17:30
// @ 15 kW as its own entry. A plan applied after 17:00 deleted the ended 16:45 link (applyPlan drops
// every ended entry of ours), so at 17:02:39 replaying the schedule ramps 17:00's window from 0 at
// 17:00: 2.65 min × 1.5 kW/min = 3975 W, while the inverter has fed at the 14.4 kW cap since 16:55.
// That under-credits the slot's drain by ~0.7 kWh, budget the planner would then sell.
{
  const leadLink: FixedWindow = { startMs: hourMs(16.75), endMs: hourMs(17), watts: 15000 };
  const runningLink: FixedWindow = { startMs: hourMs(17), endMs: hourMs(17.5), watts: 15000 };
  const nowMs = hourMs(17) + 2 * 60_000 + 39_000;
  const chainInput = (runningSellSchedule: FixedWindow[], measuredFeedInW: number | undefined) =>
    eveningInput({ nowMs, socPercent: 55, fixedSells: [runningLink], runningSellSchedule, measuredFeedInW });
  const slotZeroFeedW = (runningSellSchedule: FixedWindow[], measuredFeedInW: number | undefined) =>
    buildSlots(chainInput(runningSellSchedule, measuredFeedInW))[0].feedInAtStartW;

  const fullChainW = slotZeroFeedW([leadLink, runningLink], undefined);
  const gappedReplayW = slotZeroFeedW([runningLink], undefined);
  const gappedMeasuredW = slotZeroFeedW([runningLink], EXPORT_CAP_W);
  check(
    "chain gap: the replay of the gapped schedule starts too low, the measured feed doesn't",
    Math.abs(fullChainW - EXPORT_CAP_W) < 1 && Math.abs(gappedReplayW - 3975) < 1 && gappedMeasuredW === EXPORT_CAP_W,
    `(full chain ${fullChainW} W, gapped replay ${gappedReplayW} W, gapped + measured ${gappedMeasuredW} W)`
  );
  check(
    "measured feed: capped at the running window's target (baseline feed or solar export on top)",
    slotZeroFeedW([runningLink], 15600) === EXPORT_CAP_W
  );
  check(
    "measured feed: a window paused by the overheat stop or the SOC cutoff starts from 0, not from the replay",
    slotZeroFeedW([leadLink, runningLink], 0) === 0
  );
  check(
    "measured feed: export with no sell window running (baseline feed) doesn't seed a ramp",
    buildSlots(eveningInput({ nowMs: hourMs(17.75) + 60_000, socPercent: 30, measuredFeedInW: 350 }))[0]
      .feedInAtStartW === 0
  );

  const truth = projectWithFixedWindows(chainInput([leadLink, runningLink], undefined));
  const gappedReplay = projectWithFixedWindows(chainInput([runningLink], undefined));
  const gappedMeasured = projectWithFixedWindows(chainInput([runningLink], EXPORT_CAP_W));
  check(
    "chain gap: with the measured feed the guard projects what the full chain does",
    gappedMeasured.endSocPercent === truth.endSocPercent && gappedMeasured.minSocPercent === truth.minSocPercent,
    `(end SOC ${gappedMeasured.endSocPercent}% vs ${truth.endSocPercent}%; the gapped replay alone: ${gappedReplay.endSocPercent}%)`
  );

  const truthPlan = generatePlan(chainInput([leadLink, runningLink], undefined));
  const gappedPlan = generatePlan(chainInput([runningLink], EXPORT_CAP_W));
  check(
    "chain gap: with the measured feed the plan sells no more than the full-chain plan",
    plannedSetpointKwh(truthPlan.sells) > 1 &&
      plannedSetpointKwh(gappedPlan.sells) <= plannedSetpointKwh(truthPlan.sells) + 0.05,
    `(${plannedSetpointKwh(gappedPlan.sells).toFixed(2)} vs ${plannedSetpointKwh(truthPlan.sells).toFixed(2)} kWh of new windows)`
  );
  // Re-scored against what really runs (the full chain), the gapped plan keeps the floor
  const fullChainInput = chainInput([leadLink, runningLink], undefined);
  const gappedPlanReality = projectWithFixedWindows({
    ...fullChainInput,
    fixedSells: [...fullChainInput.fixedSells, ...appliedWindows(gappedPlan.sells)],
  });
  check(
    "chain gap: the plan made with the measured feed keeps the floor in reality",
    gappedPlanReality.minSocPercent >= 6.95,
    `(min SOC ${gappedPlanReality.minSocPercent}%)`
  );
}

// ---------- A window keyed at a minute keeps its key through a replan in the same quarter ----------
// PR #77 final review: a plan at 16:52:39 starts a window in the current slot at 16:53. A replan at
// 16:54 that doesn't keep running windows (manual "Generate plan now", veto-clear, daily, startup)
// still sells that slot, so the window continues, but was keyed back to the slot start 16:45. Every
// later projection then seeded it with 8 min of ramp that never ran (16:45 → 16:53): 73 of 74 guard
// ticks 30 s later saw a breach that wasn't there.
{
  const planAtMs = hourMs(16.75) + 7 * 60_000 + 39_000;
  const firstPlan = generatePlan(eveningInput({ nowMs: planAtMs, socPercent: 40 }));
  const minuteKeyMs = hourMs(16.75) + 8 * 60_000;
  const firstApplied = appliedWindows(firstPlan.sells);
  check(
    "same-quarter replan: the first plan starts its current-slot window at the next minute",
    firstApplied.some(window => window.startMs === minuteKeyMs),
    `(${describeWindows(firstPlan.sells)})`
  );

  // Nothing is kept, so our windows are no fixed sells; the runtime's schedule still holds them
  const replanAtMs = hourMs(16.75) + 9 * 60_000;
  const replan = generatePlan(eveningInput({ nowMs: replanAtMs, socPercent: 40, runningSellSchedule: firstApplied }));
  const replanned = appliedWindows(replan.sells);
  const continuing = replanned.find(window => window.startMs < replanAtMs && window.endMs > replanAtMs);
  check(
    "same-quarter replan: the continuing window keeps the minute key",
    continuing?.startMs === minuteKeyMs,
    `(${describeWindows(replan.sells)})`
  );
  // The guard as runGuard builds it once the replan is applied, 30 s later, from the replan's SOC
  const guardProjection = projectWithFixedWindows(
    eveningInput({
      nowMs: replanAtMs + 30_000,
      socPercent: 40,
      fixedSells: replanned,
      runningSellSchedule: replanned,
    })
  );
  check(
    "same-quarter replan: a guard 30 s after it sees no breach the replan didn't",
    guardProjection.violationWh <= 1 && guardProjection.minSocPercent >= replan.projection.minSocPercent - 0.05,
    `(violation ${Math.round(guardProjection.violationWh)} Wh·slots, min SOC ${guardProjection.minSocPercent}% vs the replan's ${replan.projection.minSocPercent}%)`
  );

  // A running window that began before the current slot still keys its continuation at the slot start
  const earlierRunning: FixedWindow = { startMs: hourMs(16.5), endMs: hourMs(17), watts: 15000 };
  const continuedPlan = generatePlan(
    eveningInput({ nowMs: replanAtMs, socPercent: 40, runningSellSchedule: [earlierRunning] })
  );
  check(
    "same-quarter replan: a continuation of a window from an earlier slot starts at the slot",
    continuedPlan.sells.some(window => window.startMs === hourMs(16.75)),
    `(${describeWindows(continuedPlan.sells)})`
  );
}

finishSelftest();

function hourMs(hourOfTestDay: number): number {
  return testDayStartMs + hourOfTestDay * HOUR_MS;
}

/** An evening peak 16:45–17:30, a shoulder until 20:00, no sun, 600 W of house load */
function eveningInput(overrides: Partial<PlannerInput> & Pick<PlannerInput, "nowMs" | "socPercent">): PlannerInput {
  return {
    prices: mkPrices(24, hour => (hour >= 16.75 && hour < 17.5 ? 3.0 : hour >= 17.5 && hour < 20 ? 2.0 : 0.5)),
    solarWattsAt: () => 0,
    houseLoadWattsAt: () => 600,
    parasiticWatts: 230,
    capacityWh: 65000,
    constraintTailHours: 8,
    fixedSells: [],
    fixedBuys: [],
    sellVetoWindows: [],
    buyVetoWindows: [],
    knobs: LIVE_LIKE_KNOBS,
    ...overrides,
  };
}

/** The schedule entries applyPlan writes for these windows */
function appliedWindows(sells: PlannedWindow[]): FixedWindow[] {
  return sells.map(window => ({ startMs: window.startMs, endMs: window.endMs, watts: window.watts }));
}

function describeWindows(sells: PlannedWindow[]): string {
  return sells
    .map(
      window =>
        `${new Date(window.startMs).toISOString().slice(11, 19)}–${new Date(window.endMs).toISOString().slice(11, 16)} @${window.watts}W`
    )
    .join(", ");
}

/** Energy the new windows ask for at their setpoints (kWh): what a plan commits to, the ramp aside */
function plannedSetpointKwh(sells: PlannedWindow[]): number {
  return sells.reduce((sum, window) => sum + (window.watts * (window.endMs - window.startMs)) / HOUR_MS / 1000, 0);
}
