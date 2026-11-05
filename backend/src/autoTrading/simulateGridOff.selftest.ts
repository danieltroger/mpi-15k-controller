/**
 * Self-test of the planner's model of automatic grid-off (simulateGridOff.ts, simulate.ts): which quarters the
 * windows leave off the grid (the lead, the auto_min_off_minutes stretch, planned and fixed windows, holds only
 * while modelled), the SOC band, what an off-grid quarter does (no baseline feed: neither its drain nor its
 * credit; grid_off_saving_watts less own draw, never below 0), the solar refill's walk, a winter night that
 * sells the saved feed at the peak, and the identities: with auto off nothing in grid_off or
 * grid_off_saving_watts changes a plan, and with no feed and no saving auto on plans as auto off.
 * Run from backend/ with:
 *   yarn node src/autoTrading/simulateGridOff.selftest.ts
 */
import { buildSlots, generatePlan, projectWithFixedWindows, SLOT_MS } from "./planner.ts";
import { simulate } from "./simulate.ts";
import { offGridSocBand, offGridWindowGaps } from "./simulateGridOff.ts";
import { solarRefillFor } from "./terminalValueSolar.ts";
import { cheapDayBeforeSunnyDaysInput, sunAfterHorizon, withSolar } from "./terminalValueSolarSelftestFixtures.ts";
import {
  baseKnobs,
  check,
  finishSelftest,
  HOUR_MS,
  mkPrices,
  testDayStartMs,
  withTerminalValue,
} from "./plannerSelftestFixtures.ts";
import { DEFAULT_METER_CALIBRATION } from "../grid/meterCalibrationBounds.ts";
import type { GridOffConfig } from "../config/config.types.ts";
import type { FixedWindow, HorizonValuation, PlannerInput, PlannerKnobs, PlanResult } from "./planner.types.ts";

const AUTO_ON: GridOffConfig = { ...baseKnobs.grid_off, auto_enabled: true };
const NO_VALUE: HorizonValuation = { tailSpot: 1, endEnergySekPerKwh: 0 };

function knobsWith(gridOff: Partial<GridOffConfig>, rest: Partial<PlannerKnobs> = {}): PlannerKnobs {
  return { ...baseKnobs, ...rest, grid_off: { ...baseKnobs.grid_off, ...gridOff } };
}

function at(hour: number): number {
  return testDayStartMs + hour * HOUR_MS;
}

function window(fromHour: number, toHour: number, watts: number): FixedWindow {
  return { startMs: at(fromHour), endMs: at(toHour), watts };
}

/** A dark night from midnight, 500 W of house, the given windows fixed */
function nightInput(overrides: Partial<PlannerInput> = {}): PlannerInput {
  return {
    nowMs: testDayStartMs,
    prices: mkPrices(12, () => 1),
    solarWattsAt: () => 0,
    houseLoadWattsAt: () => 500,
    parasiticWatts: 100,
    socPercent: 50,
    capacityWh: 10_000,
    constraintTailHours: 0,
    fixedSells: [],
    fixedBuys: [],
    sellVetoWindows: [],
    buyVetoWindows: [],
    knobs: knobsWith(AUTO_ON),
    ...overrides,
  };
}

function gapsFor(input: PlannerInput, modelHolds = false, holdSlots: number[] = []): boolean[] {
  const slots = buildSlots(input);
  for (const slotIndex of holdSlots) slots[slotIndex]!.holdW = 100;
  const zeros = new Array(slots.length).fill(0);
  return offGridWindowGaps(input, slots, zeros, zeros, modelHolds);
}

function slotAt(hour: number): number {
  return Math.round((hour * HOUR_MS) / SLOT_MS);
}

/** The slots from fromHour up to toHour all off the grid (true) or all on it (false) */
function allGaps(gaps: boolean[], fromHour: number, toHour: number, offGrid: boolean): boolean {
  return gaps.slice(slotAt(fromHour), slotAt(toHour)).every(gap => gap === offGrid);
}

// ---------- which quarters the windows leave off the grid ----------
{
  const gaps = gapsFor(nightInput({ fixedBuys: [window(2, 3, 9000)] }));
  check("nothing in the way before the window: off from the start", allGaps(gaps, 0, 1.75, true));
  check(
    "the quarter whose end is past the reconnect (02:00 − 10 min) is on the grid",
    gaps[slotAt(1.75)] === false && gaps[slotAt(1.5)] === true
  );
  check("the window's own quarters are on the grid", allGaps(gaps, 2, 3, false));
  check("after the last window: off the grid to the end", allGaps(gaps, 3, 12, true));

  const shortGap = gapsFor(nightInput({ fixedBuys: [window(2, 3, 9000), window(4, 5, 9000)] }));
  check(
    "a 60 min gap leaves 50 min before the reconnect: under auto_min_off_minutes 60, all on the grid",
    allGaps(shortGap, 3, 4, false)
  );
  const longerGap = gapsFor(
    nightInput({ fixedBuys: [window(2, 3, 9000), window(4.25, 5, 9000)], knobs: knobsWith(AUTO_ON) })
  );
  check(
    "a 75 min gap (65 min before the reconnect): off, but for the quarter before the window",
    allGaps(longerGap, 3, 4, true) && longerGap[slotAt(4)] === false
  );
  const fromStart = gapsFor(nightInput({ fixedSells: [window(1, 2, 6000)] }));
  check(
    "from the plan's start: 50 min before a sell window's reconnect is too short too",
    allGaps(fromStart, 0, 1, false) && allGaps(fromStart, 2, 12, true)
  );
  const lowerMinimum = gapsFor(
    nightInput({ fixedSells: [window(1, 2, 6000)], knobs: knobsWith({ ...AUTO_ON, auto_min_off_minutes: 15 }) })
  );
  check("…but long enough with auto_min_off_minutes 15", allGaps(lowerMinimum, 0, 0.75, true));
  const longLead = gapsFor(
    nightInput({
      fixedBuys: [window(6, 7, 9000)],
      knobs: knobsWith({ ...AUTO_ON, reconnect_before_window_minutes: 60 }),
    })
  );
  check(
    "a 60 min lead puts the hour before the window on the grid",
    allGaps(longLead, 0, 5, true) && allGaps(longLead, 5, 6, false)
  );

  const slots = buildSlots(nightInput());
  const zeros = new Array(slots.length).fill(0);
  const plannedSell = [...zeros];
  plannedSell[slotAt(5)] = 3000;
  const plannedBuy = [...zeros];
  plannedBuy[slotAt(8)] = 3000;
  const plannedGaps = offGridWindowGaps(nightInput(), slots, plannedSell, plannedBuy, false);
  check(
    "planned sells and buys are windows too (the candidate schedule, not only the fixed one)",
    plannedGaps[slotAt(5)] === false && plannedGaps[slotAt(8)] === false && plannedGaps[slotAt(4.75)] === false
  );
  const holdsOff = gapsFor(nightInput(), false, [slotAt(3)]);
  const holdsOn = gapsFor(nightInput(), true, [slotAt(3)]);
  check(
    "a hold counts only while holds are modelled",
    holdsOff[slotAt(3)] === true && holdsOn[slotAt(3)] === false && holdsOn[slotAt(2.75)] === false
  );
}

// ---------- what an off-grid quarter does ----------
{
  const capacityWh = 10_000;
  const run = (input: PlannerInput) => {
    const slots = buildSlots(input);
    const zeros = new Array(slots.length).fill(0);
    return simulate(input, slots, zeros, [...zeros], NO_VALUE);
  };
  const oneHour = (
    gridOff: Partial<GridOffConfig>,
    overrides: Partial<PlannerInput> = {},
    rest: Partial<PlannerKnobs> = {}
  ) => run(nightInput({ prices: mkPrices(1, () => 1), knobs: knobsWith(gridOff, rest), ...overrides }));
  const onGrid = oneHour({ auto_enabled: false });
  const offGrid = oneHour(AUTO_ON);
  const efficiency = baseKnobs.discharge_efficiency;
  check(
    "on the grid: the battery feeds the house, the idle draw and the 350 W baseline feed",
    Math.abs(5000 - onGrid.endSocWh - (500 + 100 + 350) / efficiency) < 1e-6,
    onGrid.endSocWh.toFixed(3)
  );
  check(
    "off the grid: the house and the idle draw less 45 W, no feed",
    Math.abs(5000 - offGrid.endSocWh - (500 + 100 - 45) / efficiency) < 1e-6 && offGrid.offGridHours === 1,
    offGrid.endSocWh.toFixed(3)
  );
  check(
    "…and the feed's credit is gone (identity calibration: 0.35 kWh × (spot + bonus))",
    Math.abs(onGrid.revenueSek - offGrid.revenueSek - 0.35 * (1 + baseKnobs.sell_bonus_sek_per_kwh)) < 1e-9 &&
      offGrid.revenueSek === 0
  );
  const calibrated = oneHour({ auto_enabled: false }, {}, { meter_calibration: DEFAULT_METER_CALIBRATION });
  const calibratedOff = oneHour(AUTO_ON, {}, { meter_calibration: DEFAULT_METER_CALIBRATION });
  check(
    "at the meter calibration the feed earned little anyway; off the grid the meter counts nothing",
    calibrated.revenueSek >= 0 && calibrated.revenueSek < 0.1 && calibratedOff.revenueSek === 0,
    `${calibrated.revenueSek.toFixed(4)} / ${calibratedOff.revenueSek}`
  );
  const smallDraw = oneHour(AUTO_ON, { parasiticWatts: 20 });
  check(
    "an idle draw under the saving comes to 0, not below",
    Math.abs(5000 - smallDraw.endSocWh - 500 / efficiency) < 1e-6
  );
  check(
    "a quarter starting at auto_resume_soc_percent (90 %) is on the grid; its feed takes the battery below, and the rest are off",
    oneHour(AUTO_ON, { socPercent: 90 }).offGridHours === 0.75
  );
  check(
    "…one starting below it off (the battery falls through the band)",
    oneHour(AUTO_ON, { socPercent: 89.9 }).offGridHours === 1
  );
  check(
    "a quarter starting below min_soc_percent (10 %) is on the grid",
    oneHour(AUTO_ON, { socPercent: 9.9 }).offGridHours === 0
  );
  check(
    "one starting at it is off; it takes the battery below, and the rest are on the grid",
    oneHour(AUTO_ON, { socPercent: 10 }).offGridHours === 0.25
  );
  const band = offGridSocBand(AUTO_ON, capacityWh);
  check("the band in Wh: 1000 up to below 9000", band.fromWh === 1000 && band.belowWh === 9000);
  const daylight = oneHour(AUTO_ON, { solarWattsAt: () => 3000 });
  const daylightOn = oneHour({ auto_enabled: false }, { solarWattsAt: () => 3000 });
  check(
    "in sun (no feed on the grid either) only the smaller own draw differs",
    Math.abs(daylight.endSocWh - daylightOn.endSocWh - 45 * baseKnobs.charge_efficiency) < 1e-6
  );
}

// ---------- the identities ----------
{
  // Plans across the knobs' ranges: auto off, nothing else in grid_off or grid_off_saving_watts counts
  let differing = 0;
  let trials = 0;
  for (const socPercent of [8, 35, 70, 92]) {
    for (const fixedBuys of [[], [window(2, 3, 9000)], [window(1, 2, 100)]]) {
      for (const holdEnabled of [false, true]) {
        const input = withTerminalValue(
          {
            ...nightInput({
              prices: mkPrices(36, hour => (hour % 24 >= 17 && hour % 24 < 20 ? 2.5 : 0.6)),
              socPercent,
              capacityWh: 40_000,
              fixedBuys,
              knobs: knobsWith({ auto_enabled: false }, { hold_enabled: holdEnabled, baseline_feed_watts: 300 }),
            }),
          },
          1.2
        );
        const reference = JSON.stringify([generatePlan(input), projectWithFixedWindows(input)]);
        for (const variant of [
          { min_soc_percent: 40, auto_resume_soc_percent: 50, auto_full_soc_percent: 60 },
          { reconnect_before_window_minutes: 120, auto_min_off_minutes: 15 },
          { auto_min_off_minutes: 720 },
        ]) {
          for (const savingW of [0, 200]) {
            trials++;
            const varied = {
              ...input,
              knobs: knobsWith({ auto_enabled: false, ...variant }, { ...input.knobs, grid_off_saving_watts: savingW }),
            };
            if (JSON.stringify([generatePlan(varied), projectWithFixedWindows(varied)]) !== reference) differing++;
          }
        }
      }
    }
  }
  check(
    `auto off: no grid_off knob or saving changes a plan (${trials} trials)`,
    differing === 0,
    `${differing} differ`
  );

  // Auto on with nothing to save (no feed, no saving): the off-grid quarter is the on-grid idle one
  let differingWithoutSaving = 0;
  let notesNamed = 0;
  for (const socPercent of [20, 60, 85]) {
    const off = nightInput({
      prices: mkPrices(36, hour => (hour % 24 >= 17 && hour % 24 < 20 ? 2.5 : 0.6)),
      socPercent,
      capacityWh: 40_000,
      solarWattsAt: ms =>
        ((ms - testDayStartMs) / HOUR_MS) % 24 > 9 && ((ms - testDayStartMs) / HOUR_MS) % 24 < 15 ? 4000 : 0,
      knobs: knobsWith({ auto_enabled: false }, { baseline_feed_watts: 0, grid_off_saving_watts: 0 }),
    });
    const on: PlannerInput = {
      ...off,
      knobs: knobsWith(AUTO_ON, { baseline_feed_watts: 0, grid_off_saving_watts: 0 }),
    };
    const withoutNotes = (plan: PlanResult) => JSON.stringify({ ...plan, notes: undefined });
    const onPlan = generatePlan(on);
    if (withoutNotes(generatePlan(off)) !== withoutNotes(onPlan)) differingWithoutSaving++;
    if (JSON.stringify(projectWithFixedWindows(off)) !== JSON.stringify(projectWithFixedWindows(on)))
      differingWithoutSaving++;
    if (onPlan.notes.some(note => note.startsWith("Automatic grid-off:") && note.includes("h modelled off the grid")))
      notesNamed++;
  }
  check("auto on without a feed or a saving plans exactly as auto off", differingWithoutSaving === 0);
  check("…and its plans say what they modelled", notesNamed === 3);
}

// ---------- a winter night: the saved feed sells at the peak ----------
{
  // 22:00, 95 % of 40 kWh, a dear peak tomorrow 17–20, no sun: on the grid the night feed leaves the peak nothing
  const input = (gridOff: Partial<GridOffConfig>): PlannerInput =>
    nightInput({
      nowMs: at(22),
      prices: mkPrices(44, hour => (hour >= 41 && hour < 44 ? 3 : 0.9)),
      socPercent: 95,
      capacityWh: 40_000,
      houseLoadWattsAt: () => 600,
      constraintTailHours: 6,
      knobs: knobsWith(gridOff, { baseline_feed_watts: 300, meter_calibration: DEFAULT_METER_CALIBRATION }),
    });
  const onGrid = generatePlan(input({ auto_enabled: false }));
  const offGrid = generatePlan(input(AUTO_ON));
  check(
    "the battery not feeding the night sells more at the peak",
    offGrid.projection.plannedSellKwh > onGrid.projection.plannedSellKwh &&
      offGrid.projection.estimatedRevenueSek > onGrid.projection.estimatedRevenueSek,
    `${onGrid.projection.plannedSellKwh} → ${offGrid.projection.plannedSellKwh} kWh, ${onGrid.projection.estimatedRevenueSek} → ${offGrid.projection.estimatedRevenueSek} SEK`
  );
  const note = offGrid.notes.find(text => text.startsWith("Automatic grid-off:"));
  check(
    "…the note says how long it modelled off the grid",
    note !== undefined && !note.startsWith("Automatic grid-off: 0.0 h"),
    note
  );
  check(
    "…and the auto-off plan has no note about it",
    !onGrid.notes.some(text => text.startsWith("Automatic grid-off"))
  );
}

// ---------- the solar refill's walk: no night feed past the horizon either ----------
{
  const sunny = withSolar(cheapDayBeforeSunnyDaysInput(sunAfterHorizon(6000)));
  const feeding = { ...sunny, knobs: { ...sunny.knobs, baseline_feed_watts: 300 } };
  const autoOn = { ...feeding, knobs: { ...feeding.knobs, grid_off: AUTO_ON } };
  const horizonEndMs = buildSlots(feeding).at(-1)!.endMs;
  const valuation = { expectedSpot: 1, endEnergySekPerKwh: 2.29 };
  const refillOn = solarRefillFor(feeding, horizonEndMs, valuation);
  const refillAuto = solarRefillFor(autoOn, horizonEndMs, valuation);
  check(
    "the walk with automatic grid-off drains less, so the PV refills from a lower start",
    refillOn !== undefined && refillAuto !== undefined && refillAuto.fromWh < refillOn.fromWh,
    `${refillOn?.fromWh.toFixed(0)} → ${refillAuto?.fromWh.toFixed(0)} Wh`
  );
  const noFeed = { ...sunny, knobs: { ...sunny.knobs, baseline_feed_watts: 0, grid_off_saving_watts: 0 } };
  const noFeedAuto = { ...noFeed, knobs: { ...noFeed.knobs, grid_off: AUTO_ON } };
  check(
    "…and with neither a feed nor a saving, exactly the same walk",
    JSON.stringify(solarRefillFor(noFeed, horizonEndMs, valuation)) ===
      JSON.stringify(solarRefillFor(noFeedAuto, horizonEndMs, valuation))
  );
}

finishSelftest();
