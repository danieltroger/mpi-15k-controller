/**
 * Self-test of simulate.ts's hold slot: the house, the inverter's idle draw, hold_overhead_watts and the
 * trickle come from the grid, PV and the trickle go into the battery (the trickle only as far as there is
 * room), no baseline feed, at any SOC; a sell or a planned buy in the slot wins; fixed buy windows at hold
 * power are holds only while the plan models holds; with holds not modelled a held slot is an idle one.
 * Run from backend/ with:
 *   yarn node src/autoTrading/simulateHold.selftest.ts
 */
import { buildSlots } from "./planner.ts";
import { holdsModelled, simulate } from "./simulate.ts";
import { baseKnobs, check, finishSelftest, HOUR_MS, mkPrices, testDayStartMs } from "./plannerSelftestFixtures.ts";
import type { FixedWindow, HorizonValuation, PlannerInput, SimResult } from "./planner.types.ts";

const HOUSE_W = 900;
const PARASITIC_W = 200;
const SPOT = 0.4;
const CAPACITY_WH = 65000;
const QUARTER_H = 0.25;
const ON: HorizonValuation = { tailSpot: SPOT, endEnergySekPerKwh: 2.5 };
const holdKnobs = { ...baseKnobs, hold_enabled: true, hold_power_watts: 100, hold_overhead_watts: 100 };

/** Two dark quarters at SPOT; the first one held (or with the given fixed buy) */
function twoQuarters({
  socPercent = 60,
  pvW = 0,
  fixedBuys = [] as FixedWindow[],
  knobs = holdKnobs,
}: { socPercent?: number; pvW?: number; fixedBuys?: FixedWindow[]; knobs?: PlannerInput["knobs"] } = {}) {
  const input: PlannerInput = {
    nowMs: testDayStartMs,
    prices: mkPrices(0.5, () => SPOT),
    solarWattsAt: () => pvW,
    houseLoadWattsAt: () => HOUSE_W,
    parasiticWatts: PARASITIC_W,
    socPercent,
    capacityWh: CAPACITY_WH,
    constraintTailHours: 0,
    fixedSells: [],
    fixedBuys,
    sellVetoWindows: [],
    buyVetoWindows: [],
    knobs,
  };
  const slots = buildSlots(input);
  const none = () => new Array(slots.length).fill(0);
  return { input, slots, none };
}

function importPriceSek(wh: number): number {
  return (wh / 1000) * (SPOT + baseKnobs.buy_surcharges_sek_per_kwh) * baseKnobs.vat_multiplier;
}

// ---------- One held dark quarter ----------
{
  const { input, slots, none } = twoQuarters();
  const idle = simulate(input, slots, none(), none(), ON);
  slots[0].holdW = 100;
  const held = simulate(input, slots, none(), none(), ON);
  const expectedImportWh = (HOUSE_W + PARASITIC_W + 100 + 100) * QUARTER_H;
  const startWh = 0.6 * CAPACITY_WH;
  check(
    "hold: the house, idle draw, overhead and trickle all come from the grid",
    Math.abs(held.importWh - expectedImportWh) < 1e-6,
    `(${held.importWh.toFixed(1)} Wh, expected ${expectedImportWh})`
  );
  check(
    "hold: only the trickle goes into the battery",
    Math.abs(held.socAfterSlot[0] - (startWh + 100 * baseKnobs.charge_efficiency * QUARTER_H)) < 1e-6,
    `(${(held.socAfterSlot[0] - startWh).toFixed(2)} Wh)`
  );
  const idleDrainWh = startWh - idle.socAfterSlot[0];
  check(
    "idle, the battery carried the house, idle draw and baseline feed instead",
    Math.abs(
      idleDrainWh -
        ((HOUSE_W + PARASITIC_W + baseKnobs.baseline_feed_watts) / baseKnobs.discharge_efficiency) * QUARTER_H
    ) < 1e-6
  );
  check("hold: no baseline feed", held.autoExportWh === 0 && held.sellExportWh === 0);
  slots[1].holdW = 100;
  const bothHeld = simulate(input, slots, none(), none(), ON);
  slots[1].holdW = 0;
  const holdCashSek = bothHeld.revenueSek - bothHeld.endEnergyValueSek;
  check(
    "hold: the cash is exactly the import at the import price (no feed-in earnings)",
    Math.abs(holdCashSek + importPriceSek(2 * expectedImportWh)) < 1e-9,
    `(${holdCashSek.toFixed(4)} SEK)`
  );
  check(
    "hold: the end-of-plan credit counts the energy kept",
    held.endEnergyValueSek > idle.endEnergyValueSek &&
      Math.abs(
        held.endEnergyValueSek -
          idle.endEnergyValueSek -
          ((held.endSocWh - idle.endSocWh) / 1000) * ON.endEnergySekPerKwh
      ) < 1e-9
  );
  check("hold: no boughtWh (it isn't a charge the buy passes compare)", held.boughtWh === 0);
}

// ---------- A full battery: the house still runs from the grid (a buy window stops at 98 %) ----------
{
  const { input, slots, none } = twoQuarters({ socPercent: 100 });
  slots[0].holdW = 100;
  const held = simulate(input, slots, none(), none(), ON);
  check(
    "full battery: no trickle, the house, idle draw and overhead still from the grid, SOC stays at full",
    Math.abs(held.importWh - (HOUSE_W + PARASITIC_W + 100) * QUARTER_H) < 1e-6 && held.socAfterSlot[0] === CAPACITY_WH,
    `(${held.importWh.toFixed(1)} Wh, SOC ${held.socAfterSlot[0]})`
  );
}

// ---------- PV in a hold quarter goes into the battery, the house stays on the grid ----------
{
  const { input, slots, none } = twoQuarters({ pvW: 400 });
  slots[0].holdW = 100;
  const held = simulate(input, slots, none(), none(), ON);
  check(
    "PV during a hold: PV and the trickle charge the battery, the import is unchanged",
    Math.abs(held.socAfterSlot[0] - (0.6 * CAPACITY_WH + (400 + 100) * baseKnobs.charge_efficiency * QUARTER_H)) <
      1e-6 && Math.abs(held.importWh - (HOUSE_W + PARASITIC_W + 200) * QUARTER_H) < 1e-6
  );
}

// ---------- A sell or a planned buy wins over a hold ----------
{
  const { input, slots, none } = twoQuarters({ socPercent: 80 });
  const sellW = none();
  sellW[0] = 5000;
  const selling = simulate(input, slots, sellW, none(), ON);
  slots[0].holdW = 100;
  const sellingOverHold = simulate(input, slots, sellW, none(), ON);
  check("a sell in a held quarter: the sell, exactly as without the hold", sameResult(selling, sellingOverHold));
  slots[0].holdW = 0;
  const buyW = none();
  buyW[0] = 10000;
  const buying = simulate(input, slots, none(), buyW, ON);
  slots[0].holdW = 100;
  check("a planned buy in a held quarter: the buy", sameResult(buying, simulate(input, slots, none(), buyW, ON)));
}

// ---------- Holds not modelled: a held quarter is an idle one, fixed hold-power buys stay buys ----------
{
  const fixedHold = [{ startMs: testDayStartMs, endMs: testDayStartMs + 15 * 60_000, watts: 100 }];
  const off = { ...holdKnobs, hold_enabled: false };
  check(
    "holdsModelled: hold_enabled, a terminal value and buy windows above the hold class, all three",
    holdsModelled(holdKnobs, ON) &&
      !holdsModelled(off, ON) &&
      !holdsModelled(holdKnobs, { ...ON, endEnergySekPerKwh: 0 }) &&
      !holdsModelled({ ...holdKnobs, max_buy_power_watts: 300 }, ON) &&
      holdsModelled({ ...holdKnobs, max_buy_power_watts: 301 }, ON)
  );
  for (const [label, knobs, valuation] of [
    ["hold_enabled off", off, ON],
    ["no terminal value", holdKnobs, { ...ON, endEnergySekPerKwh: 0 }],
  ] as const) {
    const { input, slots, none } = twoQuarters({ knobs });
    const idle = simulate(input, slots, none(), none(), valuation);
    slots[0].holdW = 100;
    check(
      `${label}: a held quarter simulates as an idle one`,
      sameResult(idle, simulate(input, slots, none(), none(), valuation))
    );
    const fixed = twoQuarters({ knobs, fixedBuys: fixedHold });
    const asBuy = simulate(fixed.input, fixed.slots, fixed.none(), fixed.none(), valuation);
    check(
      `${label}: a fixed 100 W buy window is a buy (no overhead, PV credited as before)`,
      Math.abs(asBuy.importWh - (100 + HOUSE_W + PARASITIC_W) * QUARTER_H) < 1e-6 && asBuy.boughtWh === 100 * QUARTER_H
    );
  }
  const modelled = twoQuarters({ fixedBuys: fixedHold });
  const fixedAsHold = simulate(modelled.input, modelled.slots, modelled.none(), modelled.none(), ON);
  check(
    "holds modelled: a fixed 100 W buy window (a written hold the plan keeps) is a hold",
    Math.abs(fixedAsHold.importWh - (HOUSE_W + PARASITIC_W + 100 + 100) * QUARTER_H) < 1e-6 &&
      fixedAsHold.boughtWh === 0
  );
  const heavy = twoQuarters({ fixedBuys: [{ ...fixedHold[0], watts: 3000 }] });
  const heavyBuy = simulate(heavy.input, heavy.slots, heavy.none(), heavy.none(), ON);
  check("holds modelled: a fixed 3000 W buy window stays a buy", heavyBuy.boughtWh === 3000 * QUARTER_H);
}

// ---------- A sell right after a hold ramps from nothing (the baseline feed is off in a buy window) ----------
{
  const input: PlannerInput = {
    ...twoQuarters().input,
    prices: mkPrices(1, () => SPOT),
    socPercent: 80,
    knobs: { ...holdKnobs, sell_ramp_minutes: 10 },
  };
  const slots = buildSlots(input);
  const sellW = new Array(slots.length).fill(0);
  sellW[1] = 15000;
  const afterIdle = simulate(input, slots, sellW, new Array(slots.length).fill(0), ON);
  slots[0].holdW = 100;
  const afterHold = simulate(input, slots, sellW, new Array(slots.length).fill(0), ON);
  check(
    "a sell after a hold ramps from 0 W, after an idle quarter from the baseline feed",
    afterHold.sellExportWhPerSlot[1] < afterIdle.sellExportWhPerSlot[1],
    `(${afterHold.sellExportWhPerSlot[1].toFixed(0)} vs ${afterIdle.sellExportWhPerSlot[1].toFixed(0)} Wh)`
  );
  check("…and the slot is an hour's quarter later", slots[1].startMs - slots[0].startMs === HOUR_MS / 4);
}

finishSelftest();

function sameResult(first: SimResult, second: SimResult): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
}
