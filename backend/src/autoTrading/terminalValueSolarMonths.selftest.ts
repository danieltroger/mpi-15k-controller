/**
 * The solar refill's month gate, terminal_value_solar_months (terminalValueSolar.ts' solarRefillInSeason): the refill
 * only acts in the listed months, read in Swedish time at the plan's run as terminal_value_months is, so a plan on
 * the last day of February is February's even though its horizon ends in March. Outside them the plan is the plan
 * without the refill to the byte; inside, the one the refill made before the gate. The stale-forecast warning and
 * its "fresh again" line follow the gate, and a bad value is corrected with a warning. Run from backend/ with:
 *   yarn node src/autoTrading/terminalValueSolarMonths.selftest.ts
 */
import { default_config } from "../config/config.ts";
import { generatePlan, projectWithFixedWindows } from "./planner.ts";
import { plannerKnobsFromConfig } from "./plannerKnobs.ts";
import { solarForecastEndForRefill } from "./solarRefillForecast.ts";
import {
  DEFAULT_TERMINAL_VALUE_SOLAR_MONTHS,
  effectiveTerminalValueMonths,
  parseTerminalValueMonths,
  stockholmMonth,
} from "./terminalValue.ts";
import { solarRefillFor, solarRefillInSeason } from "./terminalValueSolar.ts";
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
  fullBatteryBeforeSunnyDaysInput,
  samePlanWithNotes,
  SOLAR_ON,
  sunAfterHorizon,
  withSolar,
} from "./terminalValueSolarSelftestFixtures.ts";
import type { PlannerInput } from "./planner.types.ts";

/** February 28, 2026, 13:00 in Sweden (CET) */
const FEBRUARY_28_NOON_MS = Date.UTC(2026, 1, 28, 12);
/** 23:30 UTC on February 28 is 00:30 on March 1 in Sweden */
const MARCH_1_AFTER_MIDNIGHT_MS = Date.UTC(2026, 1, 28, 23, 30);

// ---------- (a) The gate: the month in Sweden at the plan's run ----------
{
  const inSeason = (months: string, nowMs: number) =>
    solarRefillInSeason({ terminal_value_solar_months: months }, nowMs);
  check(
    'months: a February plan is out of "3" and in "2,3"',
    !inSeason("3", FEBRUARY_28_NOON_MS) && inSeason("2,3", FEBRUARY_28_NOON_MS)
  );
  check(
    "months: Swedish time (23:30 UTC on February 28 is March in Sweden)",
    inSeason("3", MARCH_1_AFTER_MIDNIGHT_MS) && !inSeason("2", MARCH_1_AFTER_MIDNIGHT_MS)
  );
  const everyMonthStartMs = Array.from({ length: 12 }, (_, monthIndex) => Date.UTC(2026, monthIndex, 15, 12));
  check(
    "months: empty = never",
    everyMonthStartMs.every(nowMs => !inSeason("", nowMs)) &&
      everyMonthStartMs.every(nowMs => inSeason(EVERY_MONTH, nowMs))
  );
  check(
    "months: stray entries and spaces are ignored, as in terminal_value_months",
    inSeason("2; x, 13 3", MARCH_1_AFTER_MIDNIGHT_MS) && !inSeason("x, 13, 4", MARCH_1_AFTER_MIDNIGHT_MS)
  );
  const defaultMonths = parseTerminalValueMonths(DEFAULT_TERMINAL_VALUE_SOLAR_MONTHS).months;
  check(
    "months: a value that isn't a string reads as the knob's default, not terminal_value_months'",
    everyMonthStartMs.every(
      nowMs =>
        solarRefillInSeason({ terminal_value_solar_months: undefined as unknown as string }, nowMs) ===
        defaultMonths.includes(stockholmMonth(nowMs))
    ),
    `(default "${DEFAULT_TERMINAL_VALUE_SOLAR_MONTHS}")`
  );
}

// ---------- (b) The plan's run month, not its horizon's end: a February plan whose walk starts in March ----------
{
  const walkStartMs = Date.UTC(2026, 2, 2);
  const valuation = { expectedSpot: 1, endEnergySekPerKwh: 2 };
  const refillWith = (months: string) =>
    solarRefillFor(walkInput(FEBRUARY_28_NOON_MS, walkStartMs, months), walkStartMs, valuation);
  check(
    "run month: a February plan gets no refill with only March listed, though its walk is all in March",
    refillWith("3") === undefined
  );
  const februaryRefill = refillWith("2");
  check(
    "run month: with February listed it does, the same as with every month",
    februaryRefill !== undefined && JSON.stringify(februaryRefill) === JSON.stringify(refillWith(EVERY_MONTH)),
    `(${JSON.stringify(februaryRefill)})`
  );
}

// ---------- (c) The plan: outside the months the one without the refill, inside the one the refill made ----------
{
  const sunny = withTerminalValue(fullBatteryBeforeSunnyDaysInput(sunAfterHorizon(10_000)), 1.0);
  const withMonths = (months: string): PlannerInput => {
    const input = withSolar(sunny);
    return { ...input, knobs: { ...input.knobs, terminal_value_solar_months: months } };
  };
  const refillOff = withSolar(sunny, { ...SOLAR_ON, terminal_value_solar_scale: 0 });
  const planMonth = String(stockholmMonth(sunny.nowMs));
  const withoutRefill = generatePlan(refillOff);
  const everyMonth = generatePlan(withMonths(EVERY_MONTH));
  const thisMonth = generatePlan(withMonths(planMonth));
  check(
    "plan: the refill acts in this scenario (it sells what the sun refills anyway)",
    everyMonth.projection.plannedSellKwh > 20 && withoutRefill.projection.plannedSellKwh === 0,
    `(${everyMonth.projection.plannedSellKwh} vs ${withoutRefill.projection.plannedSellKwh} kWh)`
  );
  check("plan: this month listed alone = every month listed", samePlanWithNotes(thisMonth, everyMonth));
  for (const [scenario, months] of [
    ["every month but this one", everyMonthExcept(sunny.nowMs)],
    ["empty", ""],
  ]) {
    check(
      `plan: months ${scenario} = the plan with the refill's scale at 0, byte for byte`,
      samePlanWithNotes(generatePlan(withMonths(months)), withoutRefill)
    );
    const replay = (input: PlannerInput) =>
      JSON.stringify(
        projectWithFixedWindows({
          ...input,
          fixedSells: everyMonth.sells.map(window => ({
            startMs: window.startMs,
            endMs: window.endMs,
            watts: window.watts,
          })),
        })
      );
    check(
      `plan: months ${scenario}, replayed windows count as with the scale at 0`,
      replay(withMonths(months)) === replay(refillOff)
    );
  }
}

// ---------- (d) The stale-forecast warning and its "fresh again" line follow the months ----------
{
  const warnings: string[] = [];
  const logLines: string[] = [];
  const consoleWarn = console.warn;
  const consoleLog = console.log;
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
  console.log = (...args: unknown[]) => logLines.push(args.map(String).join(" "));
  const nowMs = testDayStartMs + 12 * HOUR_MS;
  const knobs = {
    ...baseKnobs,
    ...SOLAR_ON,
    terminal_value_mode: "forecast" as const,
    terminal_value_months: EVERY_MONTH,
    terminal_value_solar_forecast_max_age_hours: 12,
  };
  const outOfMonths = { ...knobs, terminal_value_solar_months: everyMonthExcept(nowMs) };
  const inMonths = { ...knobs, terminal_value_solar_months: String(stockholmMonth(nowMs)) };
  const fresh = { fetchedAtMs: nowMs - HOUR_MS, rangeEndMs: nowMs + 80 * HOUR_MS };
  const stale = { fetchedAtMs: nowMs - 13 * HOUR_MS, rangeEndMs: nowMs + 60 * HOUR_MS };

  const quietFlags = { solarForecastTooOldForRefill: false };
  const quietEnd = solarForecastEndForRefill(quietFlags, stale, outOfMonths, nowMs);
  const warningsOutOfMonths = warnings.length;
  const flaggedOutOfMonths = quietFlags.solarForecastTooOldForRefill;
  // Still stale when the month comes into the list (a new month starts): the warning comes then
  solarForecastEndForRefill(quietFlags, stale, inMonths, nowMs);
  const warningsOnceInMonths = warnings.length;
  // Out of the months meanwhile: fresh again clears the flag without claiming the refill is back
  const linesBeforeFresh = logLines.length;
  solarForecastEndForRefill(quietFlags, fresh, outOfMonths, nowMs);
  const linesAfterFreshOutOfMonths = logLines.length;
  // In the months throughout: one warning, one "fresh again"
  const onFlags = { solarForecastTooOldForRefill: false };
  solarForecastEndForRefill(onFlags, stale, inMonths, nowMs);
  solarForecastEndForRefill(onFlags, stale, inMonths, nowMs);
  solarForecastEndForRefill(onFlags, fresh, inMonths, nowMs);
  console.warn = consoleWarn;
  console.log = consoleLog;
  check(
    "stale forecast: out of the refill's months no warning and no flag, and no refill either way",
    quietEnd === undefined && warningsOutOfMonths === 0 && !flaggedOutOfMonths
  );
  check(
    "stale forecast: the month coming into the list while it is stale warns then",
    warningsOnceInMonths === 1 && warnings[0].includes("valued without the solar refill")
  );
  check(
    'stale forecast: out of the months by the time it is fresh, no "fresh again" line, the flag cleared',
    linesAfterFreshOutOfMonths === linesBeforeFresh && quietFlags.solarForecastTooOldForRefill === false
  );
  check(
    'stale forecast: in the months throughout, one warning for two stale plans and one "fresh again" line',
    warnings.length === 2 &&
      logLines.filter(line => line.includes("solar forecast fresh again")).length === 1 &&
      onFlags.solarForecastTooOldForRefill === false,
    `(${warnings.length} warnings)`
  );
}

// ---------- (e) A bad value is corrected (config.json is hand-editable), warned once ----------
{
  const notAString = effectiveTerminalValueMonths([2, 3], DEFAULT_TERMINAL_VALUE_SOLAR_MONTHS);
  const strayEntry = effectiveTerminalValueMonths("2,3,13", DEFAULT_TERMINAL_VALUE_SOLAR_MONTHS);
  check(
    "correction: a non-string falls back to the solar months' default, a stray entry is dropped, empty stands",
    notAString.value === DEFAULT_TERMINAL_VALUE_SOLAR_MONTHS &&
      !!notAString.correction?.includes(`"${DEFAULT_TERMINAL_VALUE_SOLAR_MONTHS}"`) &&
      strayEntry.value === "2,3" &&
      !!strayEntry.correction &&
      effectiveTerminalValueMonths("", DEFAULT_TERMINAL_VALUE_SOLAR_MONTHS).correction === undefined,
    `(${notAString.correction}; ${strayEntry.correction})`
  );
  const warnings: string[] = [];
  const consoleWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
  const badConfig = {
    ...default_config,
    automatic_trading: { ...default_config.automatic_trading, terminal_value_solar_months: 3 as unknown as string },
  };
  const firstKnobs = plannerKnobsFromConfig(badConfig);
  plannerKnobsFromConfig(badConfig);
  const strayKnobs = plannerKnobsFromConfig({
    ...default_config,
    automatic_trading: { ...default_config.automatic_trading, terminal_value_solar_months: "3, 14" },
  });
  console.warn = consoleWarn;
  check(
    "correction: plannerKnobsFromConfig hands the planner the corrected months, warning once per bad value",
    firstKnobs.terminal_value_solar_months === DEFAULT_TERMINAL_VALUE_SOLAR_MONTHS &&
      strayKnobs.terminal_value_solar_months === "3" &&
      warnings.length === 2 &&
      warnings.every(warning => warning.includes("automatic_trading.terminal_value_solar_months")),
    `(${warnings.join(" | ")})`
  );
  check(
    "default: a month list the parser takes whole",
    effectiveTerminalValueMonths(DEFAULT_TERMINAL_VALUE_SOLAR_MONTHS, DEFAULT_TERMINAL_VALUE_SOLAR_MONTHS)
      .correction === undefined &&
      default_config.automatic_trading.terminal_value_solar_months === DEFAULT_TERMINAL_VALUE_SOLAR_MONTHS
  );
}

finishSelftest();

/**
 * terminalValueSolar.selftest.ts' hand-worked walk (a 10 kWh lossless battery, a 1 kW house, 6 kW of PV in the walk's
 * 5th and 6th hour: refilled from 4 kWh up), planned at nowMs with the refill on in these months
 */
function walkInput(nowMs: number, walkStartMs: number, months: string): PlannerInput {
  return {
    nowMs,
    prices: [],
    solarWattsAt: ms => {
      const hoursIn = Math.floor((ms - walkStartMs) / HOUR_MS);
      return hoursIn >= 4 && hoursIn < 6 ? 6000 : 0;
    },
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
      terminal_value_solar_months: months,
    },
  };
}
