/**
 * The solar refill's selftest scenarios (terminalValueSolar.selftest.ts, terminalValueSolarMonths.selftest.ts): a
 * full battery or a cheap day before sunny days after the horizon, and the refill's knobs and solar forecast end
 * switched on. Not a selftest itself.
 */
import { baseKnobs, HOUR_MS, mkPrices, testDayStartMs, withTerminalValue } from "./plannerSelftestFixtures.ts";
import type { PlannerInput, PlannerKnobs, PlanResult } from "./planner.types.ts";

export const SOLAR_ON = { terminal_value_solar_scale: 1, terminal_value_solar_lookahead_hours: 48 };

/**
 * Planning at 13:00 at 88 % SOC, dark through the horizon and its 6 h tail: 1.0 SEK with 1.6 SEK evening peaks. With
 * p̂ 1.0 a kWh left at the end is worth 2.29 SEK, so those peaks don't sell; refilled by the sun anyway, it is worth
 * the spill, 1.15.
 */
export function fullBatteryBeforeSunnyDaysInput(solarWattsAt: (ms: number) => number): PlannerInput {
  return {
    nowMs: testDayStartMs + 13 * HOUR_MS,
    prices: mkPrices(48, hour => (hour % 24 >= 17 && hour % 24 < 21 ? 1.6 : 1.0)),
    solarWattsAt,
    houseLoadWattsAt: () => 300,
    parasiticWatts: 140,
    socPercent: 88,
    capacityWh: 65000,
    constraintTailHours: 6,
    fixedSells: [],
    fixedBuys: [],
    sellVetoWindows: [],
    buyVetoWindows: [],
    knobs: { ...baseKnobs, baseline_feed_watts: 0 },
  };
}

/** terminalValue.selftest.ts's cheap day (0.01–0.04 SEK, 80 % SOC), before sunny days */
export function cheapDayBeforeSunnyDaysInput(solarWattsAt: (ms: number) => number): PlannerInput {
  return {
    nowMs: testDayStartMs + 13 * HOUR_MS,
    prices: mkPrices(48, hour => (hour % 24 < 6 ? 0.01 : 0.04)),
    solarWattsAt,
    houseLoadWattsAt: () => 300,
    parasiticWatts: 230,
    socPercent: 80,
    capacityWh: 65000,
    constraintTailHours: 0,
    fixedSells: [],
    fixedBuys: [],
    sellVetoWindows: [],
    buyVetoWindows: [],
    knobs: baseKnobs,
  };
}

/** No PV within the 48 priced hours and their tail; from day 3 on a sunny day of this peak, 06–18 UTC */
export function sunAfterHorizon(peakW: number): (ms: number) => number {
  return ms => {
    const hoursIn = (ms - testDayStartMs) / HOUR_MS;
    const hourOfDay = hoursIn % 24;
    if (hoursIn < 54 || hourOfDay < 6 || hourOfDay > 18) return 0;
    return peakW * Math.sin(((hourOfDay - 6) / 12) * Math.PI);
  };
}

/**
 * The input with the terminal value on (p̂ 1.0, unless it already has one), the solar refill's knobs (on by
 * default) and a solar forecast reaching forecastHoursPastHorizon past the plan's end
 */
export function withSolar(
  input: PlannerInput,
  solarKnobs: Pick<PlannerKnobs, "terminal_value_solar_scale" | "terminal_value_solar_lookahead_hours"> = SOLAR_ON,
  forecastHoursPastHorizon = 96
): PlannerInput {
  const withValue = input.expectedSpot ? input : withTerminalValue(input, 1.0);
  const pricedEndMs = withValue.prices[withValue.prices.length - 1].startMs + 15 * 60_000;
  const horizonEndMs = pricedEndMs + withValue.constraintTailHours * HOUR_MS;
  return {
    ...withValue,
    solarForecastEndMs: horizonEndMs + forecastHoursPastHorizon * HOUR_MS,
    knobs: { ...withValue.knobs, ...solarKnobs },
  };
}

/** Byte for byte: windows, notes, projection and SOC series */
export function samePlanWithNotes(plan: PlanResult, reference: PlanResult): boolean {
  return JSON.stringify(plan) === JSON.stringify(reference);
}
