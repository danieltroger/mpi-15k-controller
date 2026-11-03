/**
 * Self-test of the simulation's meter crediting (simulatedMeterCredit.ts in simulate.ts): the 300 W baseline
 * feed still drains its whole setpoint but earns about nothing at the meter, a rating-capped 15 kW sell is
 * credited at ~0.969 × the modelled export and a feed-in-limited one loses the reading shortfall too, a buy
 * window's import costs the converting draw plus the square-law term, the house's import past an empty
 * battery costs the pass-through draw for the share of the slot it runs, and every setting 0 reproduces the
 * uncalibrated revenue bit for bit. Run from backend/ with:
 *   yarn node src/autoTrading/simulatedMeterCredit.selftest.ts
 */
import { DEFAULT_METER_CALIBRATION, IDENTITY_METER_CALIBRATION } from "../grid/meterCalibrationBounds.ts";
import { meterExportShortfallWatts } from "../grid/meterEquivalentGrid.ts";
import { SLOT_MS } from "./planner.ts";
import { baseKnobs, check, finishSelftest, testDayStartMs } from "./plannerSelftestFixtures.ts";
import type { MeterCalibration } from "../config/config.types.ts";
import type { PlannerInput, PlannerKnobs, SimResult, Slot } from "./planner.types.ts";
import { simulate } from "./simulate.ts";
import {
  extraImportWatts,
  feedReadingShortfallWatts,
  passThroughExtraImportWatts,
  uncountedExportWatts,
} from "./simulatedMeterCredit.ts";

const SPOT = 2;
const EXPORT_PRICE = SPOT + baseKnobs.sell_bonus_sek_per_kwh;
const IMPORT_PRICE = (SPOT + baseKnobs.buy_surcharges_sek_per_kwh) * baseKnobs.vat_multiplier;

type SlotSetup = { pvW?: number; houseW?: number; sellW?: number; buyW?: number };

/** One dark-ish 15-min slot at SPOT, the battery at `socPercent`, run at the given calibration */
function simulateSlot(
  setup: SlotSetup,
  calibration: MeterCalibration,
  { socPercent = 60, knobs = {} }: { socPercent?: number; knobs?: Partial<PlannerKnobs> } = {}
): SimResult {
  const slot: Slot = {
    startMs: testDayStartMs,
    endMs: testDayStartMs + SLOT_MS,
    durationH: 0.25,
    spot: SPOT,
    pvW: setup.pvW ?? 0,
    houseW: setup.houseW ?? 500,
    fixedSellW: 0,
    fixedBuyW: 0,
    feedInAtStartW: setup.sellW ?? 0,
    runningWindowStartMs: undefined,
    holdW: 0,
  };
  const input: PlannerInput = {
    nowMs: testDayStartMs,
    prices: [{ startMs: testDayStartMs, spot: SPOT }],
    solarWattsAt: () => slot.pvW,
    houseLoadWattsAt: () => slot.houseW,
    parasiticWatts: 150,
    socPercent,
    capacityWh: 64000,
    constraintTailHours: 0,
    fixedSells: [],
    fixedBuys: [],
    sellVetoWindows: [],
    buyVetoWindows: [],
    knobs: { ...baseKnobs, baseline_feed_watts: 300, ...knobs, meter_calibration: calibration },
  };
  return simulate(input, [slot], [setup.sellW ?? 0], [setup.buyW ?? 0], { tailSpot: SPOT, endEnergySekPerKwh: 0 });
}

function near(actual: number, expected: number, tolerance = 1e-9): boolean {
  return Math.abs(actual - expected) <= tolerance;
}

// ---------- The 300 W baseline feed: drains its setpoint, the meter counts about nothing ----------
{
  const uncalibrated = simulateSlot({}, IDENTITY_METER_CALIBRATION);
  const calibrated = simulateSlot({}, DEFAULT_METER_CALIBRATION);
  check(
    "baseline feed: uncalibrated, the whole 300 W is credited",
    near(uncalibrated.revenueSek, ((300 * 0.25) / 1000) * EXPORT_PRICE),
    `(${uncalibrated.revenueSek.toFixed(4)} SEK)`
  );
  // 300 W setpoint → ~200 W reading → 200 − 200 − 1.2 × 0.04 < 0: nothing reaches the meter
  check(
    "baseline feed: at the meter it earns nothing",
    near(calibrated.revenueSek, 0),
    `(${calibrated.revenueSek} SEK)`
  );
  check(
    "baseline feed: it still drains the battery by the whole setpoint",
    calibrated.endSocWh === uncalibrated.endSocWh
  );
  const feed350 = simulateSlot({}, DEFAULT_METER_CALIBRATION, { knobs: { baseline_feed_watts: 350 } });
  // 350 W → ~250 W reading → the meter's ~48 W (2025-26 nights)
  check(
    "baseline feed: at 350 W the meter gets ~50 W",
    near(
      feed350.revenueSek / ((0.25 / 1000) * EXPORT_PRICE),
      250 - meterExportShortfallWatts(250, DEFAULT_METER_CALIBRATION),
      1e-6
    ),
    `(${(feed350.revenueSek / ((0.25 / 1000) * EXPORT_PRICE)).toFixed(1)} W)`
  );
}

// ---------- Sells: rating-capped vs feed-in-limited ----------
{
  // 15 kW setpoint with a 500 W house: the rating caps it at 14.5 kW, which is what the inverter reads
  const ratingCapped = simulateSlot({ sellW: 15000 }, DEFAULT_METER_CALIBRATION);
  const ratingCappedRaw = simulateSlot({ sellW: 15000 }, IDENTITY_METER_CALIBRATION);
  check(
    "sell: a rating-capped 15 kW sell is credited at ~0.969 × the modelled export",
    near(ratingCapped.revenueSek / ratingCappedRaw.revenueSek, 0.9688, 0.001),
    `(${(ratingCapped.revenueSek / ratingCappedRaw.revenueSek).toFixed(4)})`
  );
  check(
    "sell: the modelled export energy stays what the inverter feeds",
    ratingCapped.sellExportWh === ratingCappedRaw.sellExportWh && ratingCapped.endSocWh === ratingCappedRaw.endSocWh
  );
  check(
    "sell: no reading shortfall where the rating caps the feed",
    feedReadingShortfallWatts(15000, 14500, DEFAULT_METER_CALIBRATION) === 0 &&
      feedReadingShortfallWatts(14550, 14500, DEFAULT_METER_CALIBRATION) === 50 &&
      feedReadingShortfallWatts(10000, 14500, DEFAULT_METER_CALIBRATION) === 100
  );
  // 10 kW: the feed-in limit binds, the reading sits 100 W below it (10 kW sells read ~9.88 kW)
  const limited = simulateSlot({ sellW: 10000 }, DEFAULT_METER_CALIBRATION);
  const expectedMeterW = 9900 - meterExportShortfallWatts(9900, DEFAULT_METER_CALIBRATION);
  check(
    "sell: a 10 kW sell is credited at the meter's share of its ~9.9 kW reading",
    near(limited.revenueSek, ((expectedMeterW * 0.25) / 1000) * EXPORT_PRICE, 1e-6),
    `(${(limited.revenueSek / ((0.25 / 1000) * EXPORT_PRICE)).toFixed(0)} W credited, expected ${expectedMeterW.toFixed(0)})`
  );
}

// ---------- Imports: a buy window, and the house past an empty battery ----------
{
  const buyRaw = simulateSlot({ buyW: 12000 }, IDENTITY_METER_CALIBRATION, { socPercent: 30 });
  const buy = simulateSlot({ buyW: 12000 }, DEFAULT_METER_CALIBRATION, { socPercent: 30 });
  const importW = 12000 + 500 + 150;
  const expectedExtraW = 210 + 2.5 * (importW / 1000) ** 2;
  check(
    "buy: the import costs the converting draw plus the square-law term on top",
    near(buyRaw.revenueSek - buy.revenueSek, ((expectedExtraW * 0.25) / 1000) * IMPORT_PRICE, 1e-9),
    `(+${expectedExtraW.toFixed(0)} W at ${(importW / 1000).toFixed(2)} kW, ${(((buy.revenueSek - buyRaw.revenueSek) / buyRaw.revenueSek) * 100).toFixed(1)} %)`
  );
  check(
    "buy: the bought energy and the SOC are untouched",
    buy.boughtWh === buyRaw.boughtWh && buy.endSocWh === buyRaw.endSocWh
  );
  check(
    "buy: a slot the PV covers imports nothing, so nothing on top",
    extraImportWatts(0, 1, "AC to DC", DEFAULT_METER_CALIBRATION) === 0
  );
  // The battery empties mid-slot: the house's import runs for that share of the slot only
  check(
    "empty battery: the pass-through draw counts for the share of the slot the grid takes over",
    near(passThroughExtraImportWatts(300, 1200, DEFAULT_METER_CALIBRATION), 0.25 * (105 + 2.5 * 1.44)) &&
      near(passThroughExtraImportWatts(1200, 1200, DEFAULT_METER_CALIBRATION), 105 + 2.5 * 1.44)
  );
  const emptying = simulateSlot({ houseW: 1500 }, DEFAULT_METER_CALIBRATION, {
    socPercent: 3.05,
    knobs: { emergency_soc_floor_percent: 3 },
  });
  const emptyingRaw = simulateSlot({ houseW: 1500 }, IDENTITY_METER_CALIBRATION, {
    socPercent: 3.05,
    knobs: { emergency_soc_floor_percent: 3 },
  });
  check(
    "empty battery: the house's import past the floor costs more at the meter, the import energy unchanged",
    emptying.revenueSek < emptyingRaw.revenueSek &&
      emptying.shortfallImportWh === emptyingRaw.shortfallImportWh &&
      emptying.shortfallImportWh > 0,
    `(${emptyingRaw.revenueSek.toFixed(3)} → ${emptying.revenueSek.toFixed(3)} SEK)`
  );
}

// ---------- The export corrections never go negative or past the export ----------
{
  let bounded = true;
  for (let exportW = 0; exportW <= 16000; exportW += 50) {
    for (const shortfallW of [0, 100]) {
      const uncounted = uncountedExportWatts(exportW, shortfallW, DEFAULT_METER_CALIBRATION);
      if (uncounted < 0 || uncounted > exportW) bounded = false;
    }
    // At the identity the reading shortfall is 0 too (feedReadingShortfallWatts)
    const identityShortfallW = feedReadingShortfallWatts(exportW, 14500, IDENTITY_METER_CALIBRATION);
    if (
      identityShortfallW !== 0 ||
      uncountedExportWatts(exportW, identityShortfallW, IDENTITY_METER_CALIBRATION) !== 0
    ) {
      bounded = false;
    }
  }
  check("export: what the meter doesn't count lies in [0, the export], and is exactly 0 at the identity", bounded);
}

finishSelftest();
