/**
 * Self-test of the planner's model of automatic grid-off (simulateGridOff.ts, simulate.ts): what the windows allow
 * per quarter (the lead, the auto_min_off_minutes stretch judged from where a stretch would start, planned and
 * fixed windows, holds only while modelled); the switch's hysteresis carried through the loop (entering from the
 * floor + margin up to below resume, staying from the floor up to below full: the 12 % left after an evening sell,
 * the rising 90–95 % side, a battery falling from full); what an off-grid quarter does (the night feed's drain
 * stays, its credit and meter terms go, the battery drains grid_off_saving_watts less, never below 0); a winter
 * night; the solar refill's walk; and the identities: with auto off nothing in grid_off or grid_off_saving_watts
 * changes a plan, and with no feed and no saving auto on plans as auto off.
 * Run from backend/ with:
 *   yarn node src/autoTrading/simulateGridOff.selftest.ts
 */
import { buildSlots, generatePlan, projectWithFixedWindows, SLOT_MS } from "./planner.ts";
import { simulate } from "./simulate.ts";
import { offGridOwnDrawWatts, offGridSocBands, offGridWindowGaps } from "./simulateGridOff.ts";
import { BASELINE_FEED_SOLAR_MARGIN_WATTS } from "./simulateConstants.ts";
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
import type {
  FixedWindow,
  HorizonValuation,
  PlannerInput,
  PlannerKnobs,
  PlanResult,
  SimResult,
} from "./planner.types.ts";

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

/** A dark night from midnight, 500 W of house and 100 W idle draw on a 10 kWh battery, the given windows fixed */
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

function run(input: PlannerInput): SimResult {
  const slots = buildSlots(input);
  const zeros = new Array(slots.length).fill(0);
  return simulate(input, slots, zeros, [...zeros], NO_VALUE);
}

/**
 * Each quarter of a run off the grid (true), on it (false), or neither (undefined: a window, or the battery at an
 * edge), read off its battery change: an idle quarter's change on and off the grid differs by exactly the saving
 */
function offGridBySlot(input: PlannerInput): (boolean | undefined)[] {
  const slots = buildSlots(input);
  const result = run(input);
  const knobs = input.knobs;
  const change = (netW: number, durationH: number) =>
    netW >= 0 ? netW * knobs.charge_efficiency * durationH : (netW / knobs.discharge_efficiency) * durationH;
  return slots.map((slot, slotIndex) => {
    const before = slotIndex === 0 ? (input.socPercent / 100) * input.capacityWh : result.socAfterSlot[slotIndex - 1]!;
    const delta = result.socAfterSlot[slotIndex]! - before;
    const feedW =
      slot.pvW < slot.houseW + input.parasiticWatts + BASELINE_FEED_SOLAR_MARGIN_WATTS ? knobs.baseline_feed_watts : 0;
    const onGridDelta = change(slot.pvW - slot.houseW - input.parasiticWatts - feedW, slot.durationH);
    const offGridDelta = change(
      slot.pvW - slot.houseW - offGridOwnDrawWatts(input.parasiticWatts, feedW, knobs.grid_off_saving_watts),
      slot.durationH
    );
    if (Math.abs(delta - offGridDelta) < 1e-6) return true;
    if (Math.abs(delta - onGridDelta) < 1e-6) return false;
    return undefined;
  });
}

function slotAt(hour: number): number {
  return Math.round((hour * HOUR_MS) / SLOT_MS);
}

/** The slots from fromHour up to toHour all have this value */
function allOf<Value>(values: readonly Value[], fromHour: number, toHour: number, expected: Value): boolean {
  return values.slice(slotAt(fromHour), slotAt(toHour)).every(value => value === expected);
}

function gapsFor(input: PlannerInput, modelHolds = false, holdSlots: number[] = []) {
  const slots = buildSlots(input);
  for (const slotIndex of holdSlots) slots[slotIndex]!.holdW = 100;
  const zeros = new Array(slots.length).fill(0);
  return offGridWindowGaps(input, slots, zeros, zeros, modelHolds);
}

// ---------- what the windows allow per quarter ----------
{
  const gaps = gapsFor(nightInput({ fixedBuys: [window(2, 3, 9000)] }));
  check(
    "before a window at 02:00: off the grid may continue up to the quarter ending by its reconnect (01:50)",
    allOf(gaps.windowFree, 0, 1.75, true) && gaps.windowFree[slotAt(1.75)] === false
  );
  check(
    "…and start only where 60 min are left before it (up to the 00:45 quarter)",
    allOf(gaps.entryAllowed, 0, 1, true) && allOf(gaps.entryAllowed, 1, 2, false)
  );
  check("the window's own quarters are on the grid", allOf(gaps.windowFree, 2, 3, false));
  check("after the last window: free and enterable to the end", allOf(gaps.entryAllowed, 3, 12, true));

  const shortGap = gapsFor(nightInput({ fixedBuys: [window(2, 3, 9000), window(4, 5, 9000)] }));
  check(
    "a 60 min gap leaves 50 min before the reconnect: never enterable (auto_min_off_minutes 60)",
    allOf(shortGap.entryAllowed, 3, 4, false) && allOf(shortGap.windowFree, 3, 3.75, true)
  );
  const lowerMinimum = gapsFor(
    nightInput({
      fixedBuys: [window(2, 3, 9000), window(4, 5, 9000)],
      knobs: knobsWith({ ...AUTO_ON, auto_min_off_minutes: 15 }),
    })
  );
  check("…but enterable with auto_min_off_minutes 15", lowerMinimum.entryAllowed[slotAt(3)] === true);
  const longLead = gapsFor(
    nightInput({
      fixedBuys: [window(6, 7, 9000)],
      knobs: knobsWith({ ...AUTO_ON, reconnect_before_window_minutes: 60 }),
    })
  );
  check(
    "a 60 min lead puts the hour before the window on the grid",
    allOf(longLead.windowFree, 0, 5, true) && allOf(longLead.windowFree, 5, 6, false)
  );
  const midSlotStart = gapsFor(nightInput({ nowMs: at(0.1), fixedBuys: [window(1.25, 2, 9000)] }));
  check(
    "the first quarter's stretch counts from now: 00:06 to the 01:05 reconnect is 59 min",
    midSlotStart.entryAllowed[0] === false && midSlotStart.windowFree[0] === true
  );

  const slots = buildSlots(nightInput());
  const zeros = new Array(slots.length).fill(0);
  const plannedSell = [...zeros];
  plannedSell[slotAt(5)] = 3000;
  const plannedBuy = [...zeros];
  plannedBuy[slotAt(8)] = 3000;
  const planned = offGridWindowGaps(nightInput(), slots, plannedSell, plannedBuy, false);
  check(
    "planned sells and buys are windows too (the candidate schedule, not only the fixed one)",
    planned.windowFree[slotAt(5)] === false &&
      planned.windowFree[slotAt(8)] === false &&
      planned.windowFree[slotAt(4.75)] === false
  );
  const holdsOff = gapsFor(nightInput(), false, [slotAt(3)]);
  const holdsOn = gapsFor(nightInput(), true, [slotAt(3)]);
  check(
    "a hold counts only while holds are modelled",
    holdsOff.windowFree[slotAt(3)] === true &&
      holdsOn.windowFree[slotAt(3)] === false &&
      holdsOn.windowFree[slotAt(2.75)] === false
  );
}

// ---------- the switch's hysteresis, carried through the loop ----------
{
  // The default night drains 1.02 kW (500 + 100 + 350 feed, over 0.93) on the grid: ~2.6 pp a quarter of 10 kWh
  const falling = offGridBySlot(nightInput({ socPercent: 50 }));
  check("a night from 50 %: off the grid from the first quarter", falling[0] === true && falling[1] === true);
  // 95.5 → 92.95 → 90.4 → 87.85 %
  const fromFull = offGridBySlot(nightInput({ socPercent: 95.5 }));
  check(
    "falling from 95.5 %: on the grid (feeding) while a quarter starts at 90 % or more, off from the first below",
    fromFull.slice(0, 3).every(slot => slot === false) && fromFull[3] === true,
    fromFull.slice(0, 5).join(",")
  );
  // Until the emergency floor (3 %), where the change no longer tells: undefined
  const low = offGridBySlot(nightInput({ socPercent: 12, prices: mkPrices(2, () => 1) }));
  check(
    "12 % at night: never off (switching off needs 10 + 5 %)",
    low.slice(0, 3).every(slot => slot === false) && !low.includes(true),
    low.join(",")
  );
  const throughFloor = offGridBySlot(nightInput({ socPercent: 16, prices: mkPrices(3, () => 1) }));
  const firstOnAgain = throughFloor.indexOf(false);
  const socAtReconnect = run(nightInput({ socPercent: 16, prices: mkPrices(3, () => 1) })).socAfterSlot[
    firstOnAgain - 1
  ]!;
  check(
    "16 %: off from the start, through 15 %, and back on only once a quarter starts below 10 %",
    throughFloor[0] === true &&
      firstOnAgain > 1 &&
      throughFloor.slice(0, firstOnAgain).every(slot => slot === true) &&
      socAtReconnect < 1000 &&
      socAtReconnect >= 1000 - 260,
    `${throughFloor.join(",")}; ${socAtReconnect.toFixed(0)} Wh at the reconnect`
  );

  // The 12 % an evening sell leaves: 30 % at 18:00, a 6 kW sell 18:00–18:15 takes (6000 + 600) / 0.93 / 4 ≈ 1.77 kWh
  const afterSell: PlannerInput = nightInput({
    nowMs: at(18),
    prices: mkPrices(30, () => 1),
    socPercent: 30,
    fixedSells: [window(18, 18.25, 6000)],
    knobs: knobsWith(AUTO_ON, { runtime_soc_floor_percent: 5 }),
  });
  const afterSellSlots = offGridBySlot(afterSell);
  const afterSellSoc = run(afterSell).socAfterSlot[0]! / 100;
  check(
    "a sell leaving 10–15 %: the rest of the night on the grid (the runtime says 'battery 12 % < 15 %')",
    afterSellSoc >= 10 &&
      afterSellSoc < 15 &&
      afterSellSlots.slice(1, 4).every(slot => slot === false) &&
      !afterSellSlots.slice(1).includes(true),
    `${afterSellSoc.toFixed(1)} % after the sell; ${afterSellSlots.slice(1, 5).join(",")}`
  );
  const smallMargin = offGridBySlot({
    ...afterSell,
    knobs: knobsWith({ ...AUTO_ON, switch_on_soc_margin_percent: 1 }, { runtime_soc_floor_percent: 5 }),
  });
  check("…which a 1 % margin would switch off at once", smallMargin[1] === true, smallMargin.slice(1, 4).join(","));

  // Rising on PV: 85 % with 1.1 kW of PV from 10:00, ~1.2 pp a quarter (no feed: the PV covers the house + 380 W)
  const rising: PlannerInput = nightInput({
    nowMs: at(10),
    prices: mkPrices(14, () => 1),
    socPercent: 85,
    solarWattsAt: () => 1100,
  });
  const risingSlots = offGridBySlot(rising);
  const risingSoc = run(rising).socAfterSlot;
  const crossedFull = risingSoc.findIndex(socWh => socWh >= 9500);
  const offAbove90 = risingSlots.filter(
    (slot, slotIndex) => slot && slotIndex > 0 && risingSoc[slotIndex - 1]! >= 9000
  );
  check(
    "rising on PV from 85 %: off through 90–95 %, back on from the quarter starting at 95 % (so the PV exports)",
    crossedFull > 4 &&
      offAbove90.length >= 3 &&
      risingSlots.slice(0, crossedFull + 1).every(slot => slot === true) &&
      risingSlots[crossedFull + 1] === false,
    `${risingSlots.slice(0, crossedFull + 3).join(",")}; 95 % after quarter ${crossedFull}, ${offAbove90.length} off quarters starting at 90–95 %`
  );
  check(
    "…and on the grid it stays: the battery never comes back below 90 %",
    risingSlots.slice(crossedFull + 1).every(slot => slot === false || slot === undefined)
  );

  // Entering late in a gap: from 95.5 % the band is reached at 00:30; a window at 01:30 leaves 50 min of it
  const lateEntry = offGridBySlot(nightInput({ socPercent: 95.5, fixedBuys: [window(1.5, 2, 9000)] }));
  check(
    "the stretch counts from where the battery enters the band: 00:30 to the 01:20 reconnect is too short",
    allOf(lateEntry, 0, 1.25, false),
    lateEntry.slice(0, 6).join(",")
  );
  // A small sell 03:00–04:00 from 89 %, so the battery is still in the band after it (~45 %)
  const holdsEndIt = offGridBySlot(
    nightInput({ socPercent: 89, fixedSells: [window(3, 4, 1000)], prices: mkPrices(6, () => 1) })
  );
  check(
    "a window ends the stretch (its lead quarter on the grid) and a new one starts after it",
    holdsEndIt[slotAt(2.5)] === true && holdsEndIt[slotAt(2.75)] === false && holdsEndIt[slotAt(4)] === true,
    holdsEndIt.join(",")
  );
  const bands = offGridSocBands(AUTO_ON, 10_000);
  check(
    "the thresholds in Wh: enter 1500 up to below 9000, stay 1000 up to below 9500",
    bands.enterFromWh === 1500 && bands.enterBelowWh === 9000 && bands.stayFromWh === 1000 && bands.stayBelowWh === 9500
  );
}

// ---------- what an off-grid quarter does ----------
{
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
    "off the grid: the same drain, feed included, less the 45 W saving (the whole battery-side difference)",
    Math.abs(5000 - offGrid.endSocWh - (500 + 100 + 350 - 45) / efficiency) < 1e-6 && offGrid.offGridHours === 1,
    offGrid.endSocWh.toFixed(3)
  );
  check(
    "…and the feed earns nothing (identity calibration: 0.35 kWh × (spot + bonus) gone)",
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
  const noFeedSmallDraw = oneHour(AUTO_ON, { parasiticWatts: 20 }, { baseline_feed_watts: 0 });
  check(
    "an own draw under the saving (20 W idle, no feed) comes to 0, not below",
    Math.abs(5000 - noFeedSmallDraw.endSocWh - 500 / efficiency) < 1e-6
  );
  const daylight = oneHour(AUTO_ON, { solarWattsAt: () => 3000 });
  const daylightOn = oneHour({ auto_enabled: false }, { solarWattsAt: () => 3000 });
  check(
    "in sun (no feed on the grid either) the battery gains the 45 W",
    Math.abs(daylight.endSocWh - daylightOn.endSocWh - 45 * baseKnobs.charge_efficiency) < 1e-6
  );
  // The review's bench: 10 dark hours, 500 W house, 100 W idle, 300 W feed, 65 kWh from 60 %
  const tenHours = (gridOff: Partial<GridOffConfig>) =>
    run(
      nightInput({
        prices: mkPrices(10, () => 1),
        socPercent: 60,
        capacityWh: 65_000,
        knobs: knobsWith(gridOff, { baseline_feed_watts: 300 }),
      })
    );
  const savedWh = tenHours(AUTO_ON).endSocWh - tenHours({ auto_enabled: false }).endSocWh;
  check(
    "a 10 h night off the grid keeps 45 W × 10 h / 0.93 ≈ 484 Wh more, not the feed's ~3.7 kWh",
    Math.abs(savedWh - (45 * 10) / efficiency) < 1e-6,
    `${savedWh.toFixed(1)} Wh`
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
          { auto_min_off_minutes: 720, switch_on_soc_margin_percent: 1 },
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
    if (JSON.stringify(projectWithFixedWindows(off)) !== JSON.stringify(projectWithFixedWindows(on))) {
      differingWithoutSaving++;
    }
    if (onPlan.notes.some(note => note.startsWith("Automatic grid-off:") && note.includes("h modelled off the grid"))) {
      notesNamed++;
    }
  }
  check("auto on without a feed or a saving plans exactly as auto off", differingWithoutSaving === 0);
  check("…and its plans say what they modelled", notesNamed === 3);
}

// ---------- a winter night: the 45 W kept overnight, nothing more ----------
{
  // 22:00, 95 % of 40 kWh, a dear peak tomorrow 17–20, no sun
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
  const onGridRun = run(input({ auto_enabled: false }));
  const offGridRun = run(input(AUTO_ON));
  const keptWh = offGridRun.endSocWh - onGridRun.endSocWh;
  check(
    "no trades: the night off the grid ends with 45 W per off-grid hour more in the battery, over the discharge efficiency",
    offGridRun.offGridHours > 20 &&
      Math.abs(keptWh - (45 * offGridRun.offGridHours) / baseKnobs.discharge_efficiency) < 1e-6,
    `${offGridRun.offGridHours} h off, ${keptWh.toFixed(0)} Wh kept`
  );
  const onGrid = generatePlan(input({ auto_enabled: false }));
  const offGrid = generatePlan(input(AUTO_ON));
  check(
    "…which the peak sells (at least as much as on the grid)",
    offGrid.projection.plannedSellKwh >= onGrid.projection.plannedSellKwh &&
      offGrid.projection.plannedSellKwh - onGrid.projection.plannedSellKwh <= keptWh / 1000 + 0.1,
    `${onGrid.projection.plannedSellKwh} → ${offGrid.projection.plannedSellKwh} kWh`
  );
  const note = offGrid.notes.find(text => text.startsWith("Automatic grid-off:"));
  check(
    "…the note says how long it modelled off the grid",
    note !== undefined && !note.startsWith("Automatic grid-off: 0.0 h") && note.includes("drains 45 W less"),
    note
  );
  check(
    "…and the auto-off plan has no note about it",
    !onGrid.notes.some(text => text.startsWith("Automatic grid-off"))
  );
}

// ---------- the solar refill's walk: the night drains 45 W less past the horizon too ----------
{
  const sunny = withSolar(cheapDayBeforeSunnyDaysInput(sunAfterHorizon(6000)));
  const feeding = { ...sunny, knobs: { ...sunny.knobs, baseline_feed_watts: 300 } };
  const autoOn = { ...feeding, knobs: { ...feeding.knobs, grid_off: AUTO_ON } };
  const horizonEndMs = buildSlots(feeding).at(-1)!.endMs;
  const valuation = { expectedSpot: 1, endEnergySekPerKwh: 2.29 };
  const refillOn = solarRefillFor(feeding, horizonEndMs, valuation);
  const refillAuto = solarRefillFor(autoOn, horizonEndMs, valuation);
  check(
    "the walk with automatic grid-off drains a little less, so the PV refills from a slightly lower start",
    refillOn !== undefined &&
      refillAuto !== undefined &&
      refillAuto.fromWh < refillOn.fromWh &&
      refillOn.fromWh - refillAuto.fromWh < 2500,
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
