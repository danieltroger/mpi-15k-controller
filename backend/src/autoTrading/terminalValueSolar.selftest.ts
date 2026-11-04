/**
 * The terminal value's solar refill (terminalValueSolar.ts): the end-of-plan energy the PV surplus after the
 * horizon refills before the house drains it is worth the spill, not the import it would save. Sunny days after the
 * horizon lower the value of the top of the battery (and the plan sells it, or stops stocking it); dark days, the
 * knobs at 0 and a missing solar forecast leave the plan exactly as without it; the value falls monotonically with
 * more PV, a larger scale and a longer look-ahead, and stays between the spill value and V. Run from backend/ with:
 *   yarn node src/autoTrading/terminalValueSolar.selftest.ts
 */
import { generatePlan, projectWithFixedWindows } from "./planner.ts";
import { endEnergyCreditSek, marginalEndEnergySekPerKwh, solarRefillFor } from "./terminalValueSolar.ts";
import { terminalValueSekPerKwh } from "./terminalValue.ts";
import { solarForecastEndForRefill } from "./solarRefillForecast.ts";
import {
  baseKnobs,
  check,
  EVERY_MONTH,
  everyMonthExcept,
  finishSelftest,
  HOUR_MS,
  testDayStartMs,
  withTerminalValue,
} from "./plannerSelftestFixtures.ts";
import {
  cheapDayBeforeSunnyDaysInput,
  fullBatteryBeforeSunnyDaysInput,
  samePlanWithNotes,
  SOLAR_ON,
  sunAfterHorizon,
  withSolar,
} from "./terminalValueSolarSelftestFixtures.ts";
import type { PlannerInput, PlannerKnobs, PlanResult, SolarRefill } from "./planner.types.ts";

// ---------- (a) The walk, by hand: one threshold where "full first" starts ----------
// Lossless, no idle draw or baseline feed, a 10 kWh battery with its floor at 0: the house drains 1 kW for 4 h, then
// 6 kW of PV for 2 h nets +5 kWh an hour, then dark again. Starting at 4 kWh the battery touches the floor at 4 h and
// is exactly full at 6 h; any more and it is full without touching the floor first (the PV spills that), any less
// and it reaches the floor first (that energy averts an import).
{
  const walkStartMs = testDayStartMs;
  const input = losslessWalkInput(walkStartMs, hoursIn => (hoursIn >= 4 && hoursIn < 6 ? 6000 : 0));
  const refill = solarRefillFor(input, walkStartMs, { expectedSpot: 1, endEnergySekPerKwh: 2 });
  check(
    "walk: the refill starts where the battery is full before it ever reaches the floor",
    refill !== undefined && Math.abs(refill.fromWh - 4000) < 1e-6 && refill.fullAtMs === walkStartMs + 6 * HOUR_MS,
    `(${describeRefill(refill)})`
  );
  const longNight = losslessWalkInput(walkStartMs, hoursIn => (hoursIn >= 12 && hoursIn < 14 ? 6000 : 0));
  check(
    "walk: a night longer than the battery empties every start first: nothing is refilled",
    solarRefillFor(longNight, walkStartMs, { expectedSpot: 1, endEnergySekPerKwh: 2 }) === undefined
  );
  const pastLookahead = losslessWalkInput(walkStartMs, hoursIn => (hoursIn >= 4 && hoursIn < 6 ? 6000 : 0), {
    terminal_value_solar_lookahead_hours: 5,
  });
  const partly = solarRefillFor(pastLookahead, walkStartMs, { expectedSpot: 1, endEnergySekPerKwh: 2 });
  check(
    "walk: only the look-ahead counts (5 h sees one sunny hour: from 9 kWh up)",
    partly !== undefined && Math.abs(partly.fromWh - 9000) < 1e-6,
    `(${describeRefill(partly)})`
  );
  const forecastEndsEarly = {
    ...losslessWalkInput(walkStartMs, hoursIn => (hoursIn >= 4 && hoursIn < 6 ? 6000 : 0)),
    solarForecastEndMs: walkStartMs + 5 * HOUR_MS,
  };
  const cutByForecast = solarRefillFor(forecastEndsEarly, walkStartMs, { expectedSpot: 1, endEnergySekPerKwh: 2 });
  check(
    "walk: nor past the solar forecast's end",
    cutByForecast !== undefined && Math.abs(cutByForecast.fromWh - 9000) < 1e-6,
    `(${describeRefill(cutByForecast)})`
  );
  // An armed water heater is modelled for so long (elpatronForecast.ts); past that the load would read 0
  const loadModelEndsEarly = {
    ...losslessWalkInput(walkStartMs, hoursIn => (hoursIn >= 4 && hoursIn < 6 ? 6000 : 0)),
    houseLoadForecastEndMs: walkStartMs + 5 * HOUR_MS,
  };
  const cutByLoadModel = solarRefillFor(loadModelEndsEarly, walkStartMs, { expectedSpot: 1, endEnergySekPerKwh: 2 });
  check(
    "walk: nor past where the house-load forecast stops counting the water heater",
    cutByLoadModel !== undefined && Math.abs(cutByLoadModel.fromWh - 9000) < 1e-6,
    `(${describeRefill(cutByLoadModel)})`
  );
  // A sliver below full (here 50 Wh of 10 kWh, under 1 %) is no refill: the plan and its note stay as without one
  const sliver = losslessWalkInput(walkStartMs, hoursIn => (hoursIn === 0 ? 1050 : 0));
  check(
    "walk: a refill band under 1 % of the capacity is none",
    solarRefillFor(sliver, walkStartMs, { expectedSpot: 1, endEnergySekPerKwh: 2 }) === undefined
  );
  // A V at or below the spill (a low terminal_value_scale) takes nothing off: no refill either
  check(
    "walk: no refill when the spill is worth V or more",
    solarRefillFor(input, walkStartMs, { expectedSpot: 1, endEnergySekPerKwh: 1.05 }) === undefined
  );
  check(
    "marginal value: the refill's above fromWh, V at or below it",
    refill !== undefined &&
      marginalEndEnergySekPerKwh({ endEnergySekPerKwh: 2, solarRefill: refill }, 4500) === refill.sekPerKwh &&
      marginalEndEnergySekPerKwh({ endEnergySekPerKwh: 2, solarRefill: refill }, 4000) === 2 &&
      marginalEndEnergySekPerKwh({ endEnergySekPerKwh: 2 }, 9000) === 2
  );
  // Spill value: (spot + sell bonus) / charge efficiency, here (1 + 0.092) / 1; scale 1 credits exactly that, 0.5 halfway
  check(
    "walk: at scale 1 the refilled energy is worth the spill (the export of the PV it displaces)",
    refill !== undefined && Math.abs(refill.sekPerKwh - 1.092) < 1e-9,
    `(${refill?.sekPerKwh})`
  );
  const halfScale = solarRefillFor(
    losslessWalkInput(walkStartMs, hoursIn => (hoursIn >= 4 && hoursIn < 6 ? 6000 : 0), {
      terminal_value_solar_scale: 0.5,
    }),
    walkStartMs,
    { expectedSpot: 1, endEnergySekPerKwh: 2 }
  );
  check(
    "walk: at scale 0.5 halfway between V and the spill",
    halfScale !== undefined && Math.abs(halfScale.sekPerKwh - (2 - 0.5 * (2 - 1.092))) < 1e-9,
    `(${halfScale?.sekPerKwh})`
  );
  // The credit: V below fromWh, the refill's value above it
  const valuation = { endEnergySekPerKwh: 2, solarRefill: refill };
  check(
    "credit: V up to fromWh, the refill value above it",
    Math.abs(endEnergyCreditSek(valuation, 3000, 0) - 6) < 1e-9 &&
      Math.abs(endEnergyCreditSek(valuation, 10000, 0) - (8 + 6 * 1.092)) < 1e-9,
    `(${endEnergyCreditSek(valuation, 3000, 0)}, ${endEnergyCreditSek(valuation, 10000, 0)})`
  );
  check(
    "credit: without a refill exactly the flat credit",
    endEnergyCreditSek({ endEnergySekPerKwh: 2.287 }, 41_234.5, 1950) === (Math.max(0, 41_234.5 - 1950) / 1000) * 2.287
  );
}

// ---------- (b) Sunny days after the horizon: the top of the battery is worth the spill, and the plan sells it ----------
{
  const sunnyAfter = withSolar(fullBatteryBeforeSunnyDaysInput(sunAfterHorizon(10_000)));
  const plain = withTerminalValue(fullBatteryBeforeSunnyDaysInput(sunAfterHorizon(10_000)), 1.0);
  const withoutRefill = generatePlan(plain);
  const withRefill = generatePlan(sunnyAfter);
  check(
    "sunny after: without the refill the 1.6 SEK peaks don't beat the end-of-plan value, nothing is sold",
    withoutRefill.sells.length === 0,
    `(${withoutRefill.projection.plannedSellKwh} kWh)`
  );
  check(
    "sunny after: with it the energy the sun refills anyway is sold at the peaks",
    withRefill.projection.plannedSellKwh > 20 &&
      withRefill.projection.endSocPercent < withoutRefill.projection.endSocPercent - 20,
    `(${withRefill.projection.plannedSellKwh} kWh sold, end SOC ${withRefill.projection.endSocPercent}% vs ${withoutRefill.projection.endSocPercent}%)`
  );
  check(
    "sunny after: cash plus end-of-plan value is no lower than the plan without the refill, valued the same way",
    planValue(withRefill) >= replayedValue(sunnyAfter, withoutRefill) - 0.5,
    `(${planValue(withRefill).toFixed(1)} vs ${replayedValue(sunnyAfter, withoutRefill).toFixed(1)} SEK)`
  );
  check(
    "sunny after: the note says above which SOC the PV refills it, and by when",
    withRefill.notes.some(note =>
      /^End-of-plan energy valued at 2\.29 SEK\/kWh \(7-day mean spot 1\.00, k 0\.9\), above \d+ % SOC at 1\.15: the solar forecast fills the battery from there by \d{4}-\d\d-\d\dT\d\d:\d\dZ anyway \(solar scale 1\); the [\d.]+ kWh left above the emergency floor are worth [\d.]+ SEK/.test(
        note
      )
    ),
    `(${withRefill.notes.find(note => note.startsWith("End-of-plan"))})`
  );
  const replayed = projectWithFixedWindows({
    ...sunnyAfter,
    fixedSells: withRefill.sells.map(window => ({ startMs: window.startMs, endMs: window.endMs, watts: window.watts })),
    fixedBuys: withRefill.buys.map(window => ({ startMs: window.startMs, endMs: window.endMs, watts: window.watts })),
  });
  check(
    "sunny after: the replayed windows count the same end-of-plan value (the opportunistic replan compares them)",
    Math.abs(replayed.endEnergyValueSek - (withRefill.projection.endEnergyValueSek ?? NaN)) < 0.5 &&
      Math.abs(replayed.revenueSek - withRefill.projection.estimatedRevenueSek) < 0.5,
    `(${replayed.revenueSek} + ${replayed.endEnergyValueSek} vs ${withRefill.projection.estimatedRevenueSek} + ${withRefill.projection.endEnergyValueSek})`
  );
  // A half scale sells less than the full one, more than none
  const halfScale = generatePlan({
    ...sunnyAfter,
    knobs: { ...sunnyAfter.knobs, terminal_value_solar_scale: 0.5 },
  });
  check(
    "sunny after: the end SOC falls with the scale",
    halfScale.projection.endSocPercent <= withoutRefill.projection.endSocPercent &&
      withRefill.projection.endSocPercent <= halfScale.projection.endSocPercent,
    `(${withoutRefill.projection.endSocPercent} ≥ ${halfScale.projection.endSocPercent} ≥ ${withRefill.projection.endSocPercent} %)`
  );
}

// ---------- (c) A cheap day before sunny days: no stocking up for energy the sun brings anyway ----------
{
  const cheapThenSunny = withTerminalValue(cheapDayBeforeSunnyDaysInput(sunAfterHorizon(10_000)), 1.0);
  const stocking = generatePlan(cheapThenSunny);
  const refilled = generatePlan(withSolar(cheapDayBeforeSunnyDaysInput(sunAfterHorizon(10_000))));
  check(
    "cheap day, sunny after: without the refill it stocks up",
    stocking.projection.plannedBuyKwh > 10,
    `(${stocking.projection.plannedBuyKwh} kWh)`
  );
  check(
    "cheap day, sunny after: with it the stocking is gone",
    refilled.projection.plannedBuyKwh < 1 && !refilled.notes.some(note => note.startsWith("Stocking up")),
    `(${refilled.projection.plannedBuyKwh} kWh)`
  );
  // At scale 0.25 a refilled kWh is still worth 2.00 SEK (V 2.29 less a quarter of its gap to the 1.15 spill), more
  // than a 0.04 SEK buy costs: the block fills into the refill band, and the note quotes what its top kWh is worth
  const quarterScale = generatePlan(
    withSolar(cheapDayBeforeSunnyDaysInput(sunAfterHorizon(10_000)), {
      terminal_value_solar_scale: 0.25,
      terminal_value_solar_lookahead_hours: 48,
    })
  );
  const stockingNote = quarterScale.notes.find(note => note.startsWith("Stocking up")) ?? "";
  check(
    "cheap day, sunny after, scale 0.25: the stocking note quotes the refilled value, not V",
    stockingNote.endsWith("end-of-plan energy is worth 2.00 SEK/kWh") &&
      stocking.notes.some(note => note.endsWith("end-of-plan energy is worth 2.29 SEK/kWh")),
    `(${stockingNote})`
  );
}

// ---------- (d) Dark days, the knobs at 0, no solar forecast: exactly the plan without the refill ----------
{
  const dark = withTerminalValue(
    fullBatteryBeforeSunnyDaysInput(() => 0),
    1.0
  );
  const sunny = withTerminalValue(fullBatteryBeforeSunnyDaysInput(sunAfterHorizon(10_000)), 1.0);
  const cheapSunny = withTerminalValue(cheapDayBeforeSunnyDaysInput(sunAfterHorizon(10_000)), 1.0);
  const unchanged: [string, PlannerInput, PlannerInput][] = [
    ["dark days after the horizon", dark, withSolar(dark)],
    [
      "solar scale 0",
      sunny,
      withSolar(sunny, { terminal_value_solar_scale: 0, terminal_value_solar_lookahead_hours: 48 }),
    ],
    [
      "look-ahead 0",
      sunny,
      withSolar(sunny, { terminal_value_solar_scale: 1, terminal_value_solar_lookahead_hours: 0 }),
    ],
    ["no solar forecast (stale or missing)", sunny, { ...withSolar(sunny), solarForecastEndMs: undefined }],
    [
      "the plan's month not in terminal_value_solar_months",
      sunny,
      {
        ...withSolar(sunny),
        knobs: { ...withSolar(sunny).knobs, terminal_value_solar_months: everyMonthExcept(sunny.nowMs) },
      },
    ],
    ["a solar forecast that ends at the horizon", sunny, withSolar(sunny, SOLAR_ON, 0)],
    [
      "terminal value off",
      { ...sunny, knobs: { ...sunny.knobs, terminal_value_mode: "off" } },
      { ...withSolar(sunny), knobs: { ...withSolar(sunny).knobs, terminal_value_mode: "off" } },
    ],
    [
      "cheap day, solar scale 0",
      cheapSunny,
      withSolar(cheapSunny, { terminal_value_solar_scale: 0, terminal_value_solar_lookahead_hours: 48 }),
    ],
  ];
  for (const [scenario, reference, candidate] of unchanged) {
    check(`unchanged with ${scenario}`, samePlanWithNotes(generatePlan(candidate), generatePlan(reference)));
  }
}

// ---------- (e) Monotone and bounded: more PV, a larger scale, a longer look-ahead never value the energy higher ----------
{
  let seed = 7;
  const random = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
  let monotoneInPv = true;
  let monotoneInScale = true;
  let monotoneInLookahead = true;
  let concaveAndBounded = true;
  let failures = "";
  for (let trial = 0; trial < 300; trial++) {
    const walkStartMs = testDayStartMs + Math.floor(random() * 96) * 15 * 60_000;
    const dayPeaksW = Array.from({ length: 4 }, () => random() * 14_000);
    const houseW = 200 + random() * 2500;
    const pvAt = (pvScale: number) => (ms: number) => {
      const day = Math.floor((ms - testDayStartMs) / (24 * HOUR_MS));
      const hourOfDay = ((ms - testDayStartMs) / HOUR_MS) % 24;
      const peakW = dayPeaksW[Math.min(day, dayPeaksW.length - 1)];
      return hourOfDay >= 6 && hourOfDay <= 18 ? pvScale * peakW * Math.sin(((hourOfDay - 6) / 12) * Math.PI) : 0;
    };
    const knobs: PlannerKnobs = {
      ...baseKnobs,
      terminal_value_solar_scale: 0.2 + random() * 0.8,
      terminal_value_solar_lookahead_hours: 12 + Math.floor(random() * 60),
      baseline_feed_watts: random() < 0.5 ? 0 : 300,
    };
    const inputFor = (pvScale: number, knobOverrides: Partial<PlannerKnobs> = {}): PlannerInput => ({
      ...fullBatteryBeforeSunnyDaysInput(pvAt(pvScale)),
      houseLoadWattsAt: () => houseW,
      solarForecastEndMs: walkStartMs + 100 * HOUR_MS,
      knobs: { ...knobs, ...knobOverrides },
    });
    const expectedSpot = random() * 2.5;
    const fullValue = terminalValueSekPerKwh(knobs, expectedSpot);
    const valuation = { expectedSpot, endEnergySekPerKwh: fullValue };
    const creditAt = (refill: SolarRefill | undefined, endSocWh: number) =>
      endEnergyCreditSek({ endEnergySekPerKwh: fullValue, solarRefill: refill }, endSocWh, 1950);
    const lessPv = solarRefillFor(inputFor(0.6), walkStartMs, valuation);
    const morePv = solarRefillFor(inputFor(1), walkStartMs, valuation);
    const largerScale = solarRefillFor(inputFor(1, { terminal_value_solar_scale: 1 }), walkStartMs, valuation);
    const longerLookahead = solarRefillFor(
      inputFor(1, { terminal_value_solar_lookahead_hours: knobs.terminal_value_solar_lookahead_hours + 24 }),
      walkStartMs,
      valuation
    );
    const spill = Math.min(
      fullValue,
      Math.max(0, (expectedSpot + knobs.sell_bonus_sek_per_kwh) / knobs.charge_efficiency)
    );
    // From the emergency floor (1950 Wh) up: below it the credit is 0, with or without the refill
    for (let endSocWh = 1950; endSocWh <= 65_000; endSocWh += 2500) {
      const tolerance = 1e-9;
      if (creditAt(morePv, endSocWh) > creditAt(lessPv, endSocWh) + tolerance) monotoneInPv = false;
      if (creditAt(largerScale, endSocWh) > creditAt(morePv, endSocWh) + tolerance) monotoneInScale = false;
      if (creditAt(longerLookahead, endSocWh) > creditAt(morePv, endSocWh) + tolerance) monotoneInLookahead = false;
      const keptKwh = Math.max(0, endSocWh - 1950) / 1000;
      const credit = creditAt(morePv, endSocWh);
      const marginalHere = creditAt(morePv, endSocWh + 1000) - credit;
      const marginalAbove = creditAt(morePv, endSocWh + 2000) - creditAt(morePv, endSocWh + 1000);
      if (
        credit > keptKwh * fullValue + tolerance ||
        credit < keptKwh * spill - tolerance ||
        marginalAbove > marginalHere + tolerance ||
        marginalHere < -tolerance
      ) {
        concaveAndBounded = false;
        failures ||= `trial ${trial} at ${endSocWh} Wh: ${credit} (${describeRefill(morePv)})`;
      }
    }
  }
  check("monotone: more PV never values the end energy higher", monotoneInPv);
  check("monotone: a larger solar scale never values it higher", monotoneInScale);
  check("monotone: a longer look-ahead never values it higher", monotoneInLookahead);
  check(
    "bounded and concave: between the spill value and V per kWh, never falling with more energy, each kWh worth no more than the one below",
    concaveAndBounded,
    failures
  );
}

// ---------- (f) A stale solar forecast: no refill, said once in the log (and once when it is fresh again) ----------
// Only while the refill applies: the terminal value on and in season, its knobs above 0
{
  const warnings: string[] = [];
  const logLines: string[] = [];
  const consoleWarn = console.warn;
  const consoleLog = console.log;
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
  console.log = (...args: unknown[]) => logLines.push(args.map(String).join(" "));
  const knobs = {
    ...baseKnobs,
    ...SOLAR_ON,
    terminal_value_mode: "forecast" as const,
    terminal_value_months: EVERY_MONTH,
    terminal_value_solar_forecast_max_age_hours: 12,
  };
  const nowMs = testDayStartMs + 12 * HOUR_MS;
  const fresh = { fetchedAtMs: nowMs - HOUR_MS, rangeEndMs: nowMs + 80 * HOUR_MS };
  const stale = { fetchedAtMs: nowMs - 13 * HOUR_MS, rangeEndMs: nowMs + 60 * HOUR_MS };
  const flags = { solarForecastTooOldForRefill: false };
  const freshEnd = solarForecastEndForRefill(flags, fresh, knobs, nowMs);
  const staleEnds = [1, 2, 3].map(() => solarForecastEndForRefill(flags, stale, knobs, nowMs));
  const warningsWhileStale = warnings.length;
  const freshAgainEnd = solarForecastEndForRefill(flags, fresh, knobs, nowMs);
  solarForecastEndForRefill(flags, fresh, knobs, nowMs);
  const freshAgainLines = logLines.filter(line => line.includes("solar forecast fresh again")).length;
  // The max age is the knob's: at 24 h the same forecast is still fresh enough
  const laxerEnd = solarForecastEndForRefill(
    { solarForecastTooOldForRefill: false },
    stale,
    { ...knobs, terminal_value_solar_forecast_max_age_hours: 24 },
    nowMs
  );
  // Quiet where the refill doesn't apply: its scale at 0, out of season (a July outage), or out of its own months
  const quietCases = [
    { ...knobs, terminal_value_solar_scale: 0 },
    { ...knobs, terminal_value_months: everyMonthExcept(nowMs) },
    { ...knobs, terminal_value_mode: "off" as const },
    { ...knobs, terminal_value_solar_months: everyMonthExcept(nowMs) },
  ].map(quietKnobs => {
    const quietFlags = { solarForecastTooOldForRefill: false };
    return {
      end: solarForecastEndForRefill(quietFlags, stale, quietKnobs, nowMs),
      flagged: quietFlags.solarForecastTooOldForRefill,
    };
  });
  // Stale while on, then switched off: fresh again clears the flag without claiming the refill is back
  const switchedOffFlags = { solarForecastTooOldForRefill: false };
  solarForecastEndForRefill(switchedOffFlags, stale, knobs, nowMs);
  const linesBeforeSwitchOff = logLines.length;
  solarForecastEndForRefill(switchedOffFlags, fresh, { ...knobs, terminal_value_solar_scale: 0 }, nowMs);
  console.warn = consoleWarn;
  console.log = consoleLog;
  check(
    "stale forecast: a fresh one's range end reaches the planner",
    freshEnd === fresh.rangeEndMs && freshAgainEnd === fresh.rangeEndMs && laxerEnd === stale.rangeEndMs
  );
  check(
    "stale forecast: past the max age none does (the refill is left out), on every plan",
    staleEnds.every(end => end === undefined)
  );
  check(
    "stale forecast: one warning for three stale plans, one line when it is fresh again",
    warningsWhileStale === 1 && warnings[0].includes("valued without the solar refill") && freshAgainLines === 1,
    `(${warningsWhileStale} warnings, ${freshAgainLines} fresh-again lines)`
  );
  check(
    "stale forecast: no warning while the refill doesn't apply (scale 0, out of season, mode off, out of its months)",
    quietCases.every(({ end, flagged }) => end === undefined && !flagged) && warnings.length === 2,
    `(${warnings.length} warnings: one per stale-while-on episode, two episodes)`
  );
  check(
    "stale forecast: switched off meanwhile, fresh again says nothing (and clears the flag)",
    logLines.length === linesBeforeSwitchOff && switchedOffFlags.solarForecastTooOldForRefill === false
  );
}

finishSelftest();

/**
 * A walk with round numbers: a 10 kWh lossless battery with its floor at 0, no idle draw or baseline feed, a 1 kW
 * house, and the PV given by the hour from walkStartMs
 */
function losslessWalkInput(
  walkStartMs: number,
  pvByHourIn: (hoursIn: number) => number,
  knobOverrides: Partial<PlannerKnobs> = {}
): PlannerInput {
  return {
    nowMs: walkStartMs - 24 * HOUR_MS,
    prices: [],
    solarWattsAt: ms => pvByHourIn(Math.floor((ms - walkStartMs) / HOUR_MS)),
    solarForecastEndMs: walkStartMs + 100 * HOUR_MS,
    houseLoadWattsAt: () => 1000,
    parasiticWatts: 0,
    socPercent: 50,
    capacityWh: 10_000,
    constraintTailHours: 0,
    fixedSells: [],
    fixedBuys: [],
    sellVetoWindows: [],
    buyVetoWindows: [],
    knobs: {
      ...baseKnobs,
      ...SOLAR_ON,
      charge_efficiency: 1,
      discharge_efficiency: 1,
      emergency_soc_floor_percent: 0,
      baseline_feed_watts: 0,
      ...knobOverrides,
    },
  };
}

/** Cash plus end-of-plan value: what the planner maximises */
function planValue(plan: PlanResult): number {
  return plan.projection.estimatedRevenueSek + (plan.projection.endEnergyValueSek ?? 0);
}

/** A plan's windows replayed on this input: its cash plus end-of-plan value as this input values them */
function replayedValue(input: PlannerInput, plan: PlanResult): number {
  const replayed = projectWithFixedWindows({
    ...input,
    fixedSells: plan.sells.map(window => ({ startMs: window.startMs, endMs: window.endMs, watts: window.watts })),
    fixedBuys: plan.buys.map(window => ({ startMs: window.startMs, endMs: window.endMs, watts: window.watts })),
  });
  return replayed.revenueSek + replayed.endEnergyValueSek;
}

function describeRefill(refill: SolarRefill | undefined): string {
  if (!refill) return "no refill";
  return `from ${refill.fromWh.toFixed(0)} Wh at ${refill.sekPerKwh.toFixed(3)} SEK/kWh, full at +${((refill.fullAtMs - testDayStartMs) / HOUR_MS).toFixed(2)} h`;
}
