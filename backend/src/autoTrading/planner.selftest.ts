/**
 * Synthetic-scenario self-test for the planner. Run from backend/ with:
 *   yarn node --loader @swc-node/register/esm src/autoTrading/planner.selftest.ts
 */
import { generatePlan, PlannerInput, projectWithFixedWindows, SLOT_MS } from "./planner";

const H = 3600_000;
const baseKnobs = {
  maxSellPowerWatts: 15000,
  batteryMaxDischargeWatts: 13000,
  maxBuyPowerWatts: 10000,
  plannerSocFloorPercent: 20,
  runtimeSocFloorPercent: 15,
  emergencySocFloorPercent: 3,
  extraReserveKwh: 0,
  minSellSpotSekPerKwh: 0.08,
  minGainSekPerSlot: 0.25,
  minWindowMinutes: 30,
  chargeEfficiency: 0.95,
  dischargeEfficiency: 0.93,
  buySurchargesSekPerKwh: 1.186,
  vatMultiplier: 1.25,
  sellBonusSekPerKwh: 0.092,
  minBuySavingSekPerKwh: 0.3,
  baselineFeedWatts: 350,
};

// t0 = a midnight-aligned "now"
const t0 = Math.floor(Date.now() / (24 * H)) * 24 * H;

function mkPrices(hours: number, priceAtHour: (h: number) => number) {
  const out: { startMs: number; spot: number }[] = [];
  for (let ms = t0; ms < t0 + hours * H; ms += SLOT_MS) {
    out.push({ startMs: ms, spot: priceAtHour((ms - t0) / H) });
  }
  return out;
}

const fails: string[] = [];
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name} ${detail}`);
  if (!cond) fails.push(name);
}

// ---------- Scenario 1: winter deficit → pre-buy at cheap night hours ----------
{
  const input: PlannerInput = {
    nowMs: t0,
    prices: mkPrices(36, h => (h % 24 < 6 ? 0.2 : h % 24 >= 17 && h % 24 <= 21 ? 2.5 : 1.0)),
    solarWattsAt: () => 0,
    houseLoadWattsAt: () => 800,
    parasiticWatts: 230,
    socPercent: 15,
    capacityWh: 65000,
    constraintTailHours: 12,
    fixedSells: [],
    fixedBuys: [],
    sellVetoWindows: [],
    buyVetoWindows: [],
    knobs: baseKnobs,
  };
  const plan = generatePlan(input);
  const buysAtNight = plan.buys.every(w => {
    const h = ((w.startMs - t0) / H) % 24;
    return h < 6.01;
  });
  check("winter: buys scheduled", plan.buys.length > 0, `(${plan.buys.length} windows)`);
  check("winter: buys at cheap night hours", buysAtNight);
  check("winter: no sells at 15% SOC with no sun", plan.sells.length === 0, `(${plan.sells.length})`);
  // Pre-buying at 0.2 to cover 0.2-priced consumption would only add battery losses — the win
  // is displacing expensive-hour imports, visible as cost reduction vs the no-trade baseline.
  check(
    "winter: import bill reduced vs baseline",
    plan.projection.estimatedRevenueSek > plan.projection.baselineRevenueSek + 15,
    `(${plan.projection.estimatedRevenueSek} vs baseline ${plan.projection.baselineRevenueSek} SEK)`
  );
  console.log(
    "  buys:",
    plan.buys.map(w => `${new Date(w.startMs).toISOString()}+${(w.endMs - w.startMs) / 60000}m`).join(", ")
  );
}

// ---------- Scenario 2: sunny surplus, user window respected + veto respected ----------
{
  const sunnyDay = (h: number) => {
    const hh = h % 24;
    return hh >= 6 && hh <= 20 ? Math.max(0, Math.sin(((hh - 6) / 14) * Math.PI)) * 12000 : 0;
  };
  const priceCurve = (h: number) => {
    const hh = h % 24;
    if (hh >= 19 && hh <= 22) return 1.2; // evening peak
    if (hh >= 7 && hh <= 9) return 0.9; // morning peak
    if (hh >= 11 && hh <= 15) return 0.1; // midday cheap
    return 0.4;
  };
  const userWindow = { startMs: t0 + 30 * H, endMs: t0 + 32 * H, watts: 5000 }; // tomorrow 06:00-08:00
  const veto = { startMs: t0 + 43 * H, endMs: t0 + 46 * H }; // tomorrow 19:00-22:00 vetoed
  const input: PlannerInput = {
    nowMs: t0 + 13 * H, // planning at 13:00 with full next-day prices
    prices: mkPrices(48, priceCurve),
    solarWattsAt: ms => sunnyDay((ms - t0) / H),
    houseLoadWattsAt: () => 600,
    parasiticWatts: 230,
    socPercent: 70,
    capacityWh: 65000,
    constraintTailHours: 12,
    fixedSells: [userWindow],
    fixedBuys: [],
    sellVetoWindows: [veto],
    buyVetoWindows: [],
    knobs: baseKnobs,
  };
  const plan = generatePlan(input);
  const overlapsUser = plan.sells.some(w => w.startMs < userWindow.endMs && w.endMs > userWindow.startMs);
  const overlapsVeto = plan.sells.some(w => w.startMs < veto.endMs && w.endMs > veto.startMs);
  check("sunny: sells planned", plan.sells.length > 0, `(${plan.sells.length} windows)`);
  check("sunny: no overlap with user's fixed window", !overlapsUser);
  check("sunny: vetoed evening range left alone", !overlapsVeto);
  check(
    "sunny: tonight's 19-22 peak used",
    plan.sells.some(w => {
      const h = (w.startMs - t0) / H;
      return h >= 18.9 && h < 23;
    })
  );
  check("sunny: no buying", plan.buys.length === 0);
  check("sunny: min SOC above floor", plan.projection.minSocPercent >= 19.9, `(${plan.projection.minSocPercent}%)`);
  console.log(
    "  sells:",
    plan.sells.map(w => `h${(w.startMs - t0) / H}-h${(w.endMs - t0) / H}@${w.avgSpot.toFixed(2)}`).join(", ")
  );
}

// ---------- Scenario 3: guard projection flags an oversized schedule ----------
{
  const input: PlannerInput = {
    nowMs: t0 + 18 * H,
    prices: mkPrices(24, () => 0.5),
    solarWattsAt: () => 0,
    houseLoadWattsAt: () => 600,
    parasiticWatts: 230,
    socPercent: 40,
    capacityWh: 65000,
    constraintTailHours: 12,
    // 4h of 15kW selling from a 40% battery — must breach the floor
    fixedSells: [{ startMs: t0 + 19 * H, endMs: t0 + 23 * H, watts: 15000 }],
    fixedBuys: [],
    sellVetoWindows: [],
    buyVetoWindows: [],
    knobs: baseKnobs,
  };
  const proj = projectWithFixedWindows(input);
  check(
    "guard: oversized schedule breaches floor",
    proj.violationWh > 1000,
    `(violation ${Math.round(proj.violationWh)} Wh)`
  );
  const projEmpty = projectWithFixedWindows({ ...input, fixedSells: [] });
  check(
    "guard: without the window no breach",
    projEmpty.violationWh < proj.violationWh,
    `(${Math.round(projEmpty.violationWh)} Wh)`
  );
}

// ---------- Scenario 4: extra reserve knob keeps energy back ----------
{
  const priceCurve = (h: number) => (h % 24 >= 19 && h % 24 <= 22 ? 1.2 : 0.3);
  const sunnyDay = (h: number) => {
    const hh = h % 24;
    return hh >= 6 && hh <= 20 ? Math.max(0, Math.sin(((hh - 6) / 14) * Math.PI)) * 12000 : 0;
  };
  const mk = (extra: number): PlannerInput => ({
    nowMs: t0 + 13 * H,
    prices: mkPrices(36, priceCurve),
    solarWattsAt: ms => sunnyDay((ms - t0) / H),
    houseLoadWattsAt: () => 600,
    parasiticWatts: 230,
    socPercent: 90,
    capacityWh: 65000,
    constraintTailHours: 12,
    fixedSells: [],
    fixedBuys: [],
    sellVetoWindows: [],
    buyVetoWindows: [],
    knobs: { ...baseKnobs, extraReserveKwh: extra },
  });
  const withoutReserve = generatePlan(mk(0));
  const withReserve = generatePlan(mk(20));
  check(
    "reserve: 20 kWh knob reduces planned selling",
    withReserve.projection.plannedSellKwh < withoutReserve.projection.plannedSellKwh - 10,
    `(${withReserve.projection.plannedSellKwh} vs ${withoutReserve.projection.plannedSellKwh} kWh)`
  );
  check(
    "reserve: min SOC raised accordingly",
    withReserve.projection.minSocPercent > withoutReserve.projection.minSocPercent + 15,
    `(${withReserve.projection.minSocPercent}% vs ${withoutReserve.projection.minSocPercent}%)`
  );
}

console.log(fails.length ? `\n${fails.length} FAILURES: ${fails.join(", ")}` : "\nAll scenarios passed");
process.exit(fails.length ? 1 : 0);
