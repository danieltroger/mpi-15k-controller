/**
 * Self-test for the overheat sell stop: the 97/90 °C hysteresis, staleness holds, a swapped limit
 * pair, and what a live sell window exports through an overheat — plus decideSellExport pinned
 * against the shouldSellPower memo body it was lifted from. Run from backend/ with:
 *   yarn node src/feeding/overheatSellStop.selftest.ts
 *
 * The temperature traces follow the 2025-06-30 shape: ~14 kW selling, ventilation shut, the inverter
 * climbing towards its 100 °C fault-57 latch.
 */
import process from "process";
import {
  effectiveResumeBelowCelsius,
  MAX_TEMPERATURE_READING_AGE_MS,
  OVERHEAT_SELL_STOP_BOOT_STATE,
  overheatLimitsMisordered,
  type OverheatSellStopLimits,
  type OverheatSellStopState,
  stepOverheatSellStop,
} from "./overheatSellStop.ts";
import { decideSellExport, type SellExportLimits } from "./sellExportDecision.ts";
import { default_config } from "../config/config.ts";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.error(`FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

const limits: OverheatSellStopLimits = {
  only_sell_below_inverter_temp_celsius: 97,
  start_selling_again_below_inverter_temp_celsius: 90,
};
const sellLimits: SellExportLimits = {
  only_sell_above_soc: 13,
  start_selling_again_above_soc: 25,
  only_sell_above_voltage: 49.8,
  start_selling_again_above_voltage: 52.2,
};
const nowMs = 1_751_300_000_000;
const windowWatts = 14_000;
const STOPPED: OverheatSellStopState = { sellingStopped: true, flipReading: { value: 97.4, time: nowMs - 60_000 } };

// ——— hysteresis ———
check(
  "defaults are 97 °C stop / 90 °C resume",
  [
    default_config.scheduled_power_selling.only_sell_below_inverter_temp_celsius,
    default_config.scheduled_power_selling.start_selling_again_below_inverter_temp_celsius,
  ],
  [97, 90]
);
check("96.9 °C keeps selling", stepAt(OVERHEAT_SELL_STOP_BOOT_STATE, 96.9).sellingStopped, false);
check("97.0 °C stops selling (≥)", stepAt(OVERHEAT_SELL_STOP_BOOT_STATE, 97).sellingStopped, true);
check("the flip records the reading that crossed", stepAt(OVERHEAT_SELL_STOP_BOOT_STATE, 98.2).flipReading, {
  value: 98.2,
  time: nowMs,
});
check("95 °C inside the gap stays stopped", stepAt(STOPPED, 95).sellingStopped, true);
check("exactly 90.0 °C stays stopped (resume is strictly below)", stepAt(STOPPED, 90).sellingStopped, true);
check("89.9 °C resumes selling", stepAt(STOPPED, 89.9).sellingStopped, false);
check("95 °C after resuming keeps selling", stepAt({ sellingStopped: false }, 95).sellingStopped, false);
check(
  "no flip returns the previous object itself (memo identity, nothing re-fires downstream)",
  [stepAt(STOPPED, 93) === STOPPED, stepAt(OVERHEAT_SELL_STOP_BOOT_STATE, 60) === OVERHEAT_SELL_STOP_BOOT_STATE],
  [true, true]
);

const liveStoreEntry = { value: 97.5, time: nowMs };
const stoppedFromStoreEntry = stepOverheatSellStop({
  ...limits,
  previousState: OVERHEAT_SELL_STOP_BOOT_STATE,
  reading: liveStoreEntry,
  nowMs,
});
liveStoreEntry.value = 99.1;
check("flipReading is a copy, not the in-place-updated store entry", stoppedFromStoreEntry.flipReading?.value, 97.5);

// ——— staleness: never flip on data the serial session stopped refreshing ———
check(
  "a stale 99 °C reading does not stop selling",
  stepAt(OVERHEAT_SELL_STOP_BOOT_STATE, 99, MAX_TEMPERATURE_READING_AGE_MS + 1) === OVERHEAT_SELL_STOP_BOOT_STATE,
  true
);
check(
  "a stale 80 °C reading does not resume selling",
  stepAt(STOPPED, 80, MAX_TEMPERATURE_READING_AGE_MS + 1) === STOPPED,
  true
);
check(
  "a reading exactly at the max age still counts",
  stepAt(STOPPED, 80, MAX_TEMPERATURE_READING_AGE_MS).sellingStopped,
  false
);
check(
  "no reading yet (boot) holds",
  stepOverheatSellStop({ ...limits, previousState: STOPPED, reading: undefined, nowMs }) === STOPPED,
  true
);

// ——— a swapped pair must not oscillate (review of #60: stop 90 / resume 95 flipped every GS round) ———
const swappedLimits: OverheatSellStopLimits = {
  only_sell_below_inverter_temp_celsius: 90,
  start_selling_again_below_inverter_temp_celsius: 95,
};
check(
  "misordered limits are detected (equal counts: no hysteresis gap)",
  [
    overheatLimitsMisordered(limits),
    overheatLimitsMisordered(swappedLimits),
    overheatLimitsMisordered({ ...limits, start_selling_again_below_inverter_temp_celsius: 97 }),
  ],
  [false, true, true]
);
check(
  "swapped limits, 92 °C held over 6 GS rounds: stops once and stays stopped",
  stateTrace(swappedLimits, [92, 92, 92, 92, 92, 92]),
  [true, true, true, true, true, true]
);
// Not min(stop, resume): a zero-width band bang-bangs, because the stop itself cools the reading a
// degree and the resume heats it back (review of b88c4b9: 15 P1/h in simulation)
check(
  "a misordered pair resumes 7 °C below the stop limit; a sane pair resumes where configured",
  [
    effectiveResumeBelowCelsius(limits),
    effectiveResumeBelowCelsius(swappedLimits),
    effectiveResumeBelowCelsius({ ...limits, start_selling_again_below_inverter_temp_celsius: 97 }),
    // A retired inverter_temp_p1_celsius of 88 seeded as the stop limit, against the default resume of 90
    effectiveResumeBelowCelsius({ ...limits, only_sell_below_inverter_temp_celsius: 88 }),
  ],
  [90, 83, 90, 81]
);
check("swapped limits (90/95) resume only below 83 °C", stateTrace(swappedLimits, [92, 94, 89.9, 83.5, 82.9]), [
  true,
  true,
  true,
  true,
  false,
]);
for (const [label, stopLimitCelsius, resumeLimitCelsius] of [
  ["equal 97/97", 97, 97],
  ["swapped 90/95", 90, 95],
  ["migrated 88 vs resume 90", 88, 90],
  ["default 97/90", 97, 90],
] as const) {
  const ditherLimits: OverheatSellStopLimits = {
    only_sell_below_inverter_temp_celsius: stopLimitCelsius,
    start_selling_again_below_inverter_temp_celsius: resumeLimitCelsius,
  };
  const trace = stateTrace(ditherLimits, ditherAtLimit(stopLimitCelsius, 30), 2 * 60_000);
  check(
    `dithering at the stop limit for an hour (${label}): one stop, no resume`,
    [countFlips(trace), trace.at(-1)],
    [1, true]
  );
}

// ——— a live 14 kW sell window through an overheat ———
const overheatTrace = [88, 94, 96.8, 97.1, 96.9, 97.3, 95, 92, 90.4, 90, 89.8, 90.3, 91, 93];
const overheatRun = runSellTicks(overheatTrace.map(temperatureCelsius => ({ temperatureCelsius })));
check(
  "window exports 14 kW, 0 from ≥97 °C until <90 °C, then 14 kW again",
  overheatRun.exportWatts,
  [14000, 14000, 14000, 0, 0, 0, 0, 0, 0, 0, 14000, 14000, 14000, 14000]
);
check(
  "what the stop withholds is the window's 14 kW, only while stopped",
  overheatRun.withheldWatts,
  [0, 0, 0, 14000, 14000, 14000, 14000, 14000, 14000, 14000, 0, 0, 0, 0]
);
check(
  "hovering at either limit flips once each way: one stop, one resume, no command churn",
  [overheatRun.stopFlips, overheatRun.resumeFlips, overheatRun.exportChanges],
  [1, 1, 2]
);

const staleRun = runSellTicks([
  { temperatureCelsius: 94 },
  { temperatureCelsius: 99, readingAgeMs: MAX_TEMPERATURE_READING_AGE_MS + 1 },
  { temperatureCelsius: 99, readingAgeMs: 10 * 60_000 },
  { temperatureCelsius: 97.2 },
  { temperatureCelsius: 85, readingAgeMs: MAX_TEMPERATURE_READING_AGE_MS + 1 },
  { temperatureCelsius: 89 },
]);
check(
  "stale readings neither stop nor resume an active window",
  staleRun.exportWatts,
  [14000, 14000, 14000, 0, 0, 14000]
);

const windowEndsRun = runSellTicks([
  { temperatureCelsius: 97.5 },
  { temperatureCelsius: 93, scheduledWatts: 0 },
  { temperatureCelsius: 89, scheduledWatts: 0 },
]);
check("a window that ends during the stop stays at 0 after cooling", windowEndsRun.exportWatts, [0, 0, 0]);

const windowStartsRun = runSellTicks([
  { temperatureCelsius: 98, scheduledWatts: 0 },
  { temperatureCelsius: 95 },
  { temperatureCelsius: 89.5 },
]);
check("a window starting while stopped feeds 0 until the inverter cooled", windowStartsRun.exportWatts, [0, 0, 14000]);
check(
  "a stop with no window withholds nothing (the P1 says nothing was curtailed)",
  windowStartsRun.withheldWatts,
  [0, 14000, 0]
);

// SOC 12 % dips below only_sell_above_soc while stopped; at 20 % (between 13 and 25) the
// SOC hysteresis must still hold selling off once the inverter has cooled
const socCutoffRun = runSellTicks([
  { temperatureCelsius: 97.5, soc: 40 },
  { temperatureCelsius: 94, soc: 12 },
  { temperatureCelsius: 88, soc: 20 },
  { temperatureCelsius: 88, soc: 26 },
]);
check(
  "the SOC cutoff hit during an overheat stop still holds after cooling",
  socCutoffRun.exportWatts,
  [0, 0, 0, 14000]
);
check(
  "a stop below the SOC cutoff withholds nothing — the cutoff already zeroed the window",
  socCutoffRun.withheldWatts,
  [14000, 0, 0, 0]
);

// ——— decideSellExport ≡ the memo body it was lifted from ———
// Below the cutoff with NO window, hitLimit must stay false: a window starting at SOC 20 then sells
// against only_sell_above_soc (13), not start_selling_again_above_soc (25)
const noWindowBelowCutoffRun = runSellTicks([
  { temperatureCelsius: 60, soc: 10, scheduledWatts: 0 },
  { temperatureCelsius: 60, soc: 20 },
]);
check(
  "below the SOC cutoff without a window does not arm the cutoff",
  [noWindowBelowCutoffRun.exportWatts, noWindowBelowCutoffRun.hitLimit],
  [
    [0, 14000],
    [false, false],
  ]
);
const voltageCutoffRun = runSellTicks([
  { temperatureCelsius: 60, voltage: 53 },
  { temperatureCelsius: 60, voltage: 49.7 },
  { temperatureCelsius: 60, voltage: 52.0 },
  { temperatureCelsius: 60, voltage: 52.3 },
]);
check(
  "the voltage pair: sag under 49.8 V cuts off, selling waits for 52.2 V",
  [voltageCutoffRun.exportWatts, voltageCutoffRun.hitLimit],
  [
    [14000, 0, 0, 14000],
    [false, true, true, false],
  ]
);

const equivalence = compareWithOriginalMemoBody();
check(
  `decideSellExport matches the original memo body on all ${equivalence.cases} SOC × voltage × hitLimit × window cases`,
  equivalence.mismatches,
  []
);
check(
  "…and while stopped it exports 0, withholds exactly what it would have sold, and evolves hitLimit identically",
  equivalence.stoppedMismatches,
  []
);
check(
  "no schedule entries export 0 (Math.max of nothing)",
  decideSellExport({
    ...sellLimits,
    scheduledWattsPerWindow: [],
    soc: 60,
    voltage: 53,
    hitLimit: false,
    sellingStoppedForOverheat: false,
  }),
  { exportWatts: 0, withheldForOverheatWatts: 0, hitLimit: false }
);

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll overheat sell stop checks passed");

function stepAt(previousState: OverheatSellStopState, temperatureCelsius: number, readingAgeMs = 0) {
  return stepOverheatSellStop({
    ...limits,
    previousState,
    reading: { value: temperatureCelsius, time: nowMs - readingAgeMs },
    nowMs,
  });
}

/** sellingStopped after each fresh reading (GS rounds arrive ~1.1 s apart) of the given temperatures */
function stateTrace(
  stopLimits: OverheatSellStopLimits,
  temperaturesCelsius: number[],
  roundIntervalMs = 1100
): boolean[] {
  let state = OVERHEAT_SELL_STOP_BOOT_STATE;
  return temperaturesCelsius.map((temperatureCelsius, roundIndex) => {
    const roundAtMs = nowMs + roundIndex * roundIntervalMs;
    state = stepOverheatSellStop({
      ...stopLimits,
      previousState: state,
      reading: { value: temperatureCelsius, time: roundAtMs },
      nowMs: roundAtMs,
    });
    return state.sellingStopped;
  });
}

/** Integer readings alternating limit / limit − 1, as the stop's own cooling and the resume's heating make them */
function ditherAtLimit(stopLimitCelsius: number, rounds: number): number[] {
  const temperaturesCelsius: number[] = [];
  for (let roundIndex = 0; roundIndex < rounds; roundIndex++) {
    temperaturesCelsius.push(roundIndex % 2 === 0 ? stopLimitCelsius : stopLimitCelsius - 1);
  }
  return temperaturesCelsius;
}

/** State changes along a trace, counting the boot state (not stopped) as the starting point */
function countFlips(trace: boolean[]): number {
  let flips = 0;
  let previouslyStopped = false;
  for (const stopped of trace) {
    if (stopped !== previouslyStopped) flips++;
    previouslyStopped = stopped;
  }
  return flips;
}

type SellTick = {
  temperatureCelsius: number;
  readingAgeMs?: number;
  /** Defaults to the 14 kW window being active */
  scheduledWatts?: number;
  soc?: number;
  voltage?: number;
};

/**
 * Replays ticks the way shouldSellPower's memos chain: the sell stop steps on the reading, then the
 * export decision runs with the carried SOC hysteresis. Counts flips and export changes — every
 * export change is a max-feed-in-power command to the inverter.
 */
function runSellTicks(ticks: SellTick[]) {
  let overheatState = OVERHEAT_SELL_STOP_BOOT_STATE;
  let hitLimit = false;
  let previousExportWatts: number | undefined;
  const result = {
    exportWatts: [] as number[],
    withheldWatts: [] as number[],
    hitLimit: [] as boolean[],
    stopFlips: 0,
    resumeFlips: 0,
    exportChanges: 0,
  };
  for (const [tickIndex, tick] of ticks.entries()) {
    const tickNowMs = nowMs + tickIndex * 60_000;
    const nextState = stepOverheatSellStop({
      ...limits,
      previousState: overheatState,
      reading: { value: tick.temperatureCelsius, time: tickNowMs - (tick.readingAgeMs ?? 0) },
      nowMs: tickNowMs,
    });
    if (nextState !== overheatState) {
      if (nextState.sellingStopped) result.stopFlips++;
      else result.resumeFlips++;
    }
    overheatState = nextState;
    const decision = decideSellExport({
      ...sellLimits,
      scheduledWattsPerWindow: [tick.scheduledWatts ?? windowWatts, 0],
      soc: tick.soc ?? 60,
      voltage: tick.voltage ?? 53,
      hitLimit,
      sellingStoppedForOverheat: overheatState.sellingStopped,
    });
    hitLimit = decision.hitLimit;
    if (previousExportWatts !== undefined && decision.exportWatts !== previousExportWatts) result.exportChanges++;
    previousExportWatts = decision.exportWatts;
    result.exportWatts.push(decision.exportWatts);
    result.withheldWatts.push(decision.withheldForOverheatWatts);
    result.hitLimit.push(decision.hitLimit);
  }
  return result;
}

/** Drives decideSellExport and the original memo body over a grid straddling every limit */
function compareWithOriginalMemoBody() {
  const socs = [5, 13, 13.1, 20, 25, 25.1, 60];
  const voltages = [49, 49.8, 49.9, 52.2, 52.3, 54];
  const windowSets = [[], [0], [0, 0], [windowWatts], [0, 9000, windowWatts]];
  const mismatches: string[] = [];
  const stoppedMismatches: string[] = [];
  let cases = 0;
  for (const soc of socs) {
    for (const voltage of voltages) {
      for (const hitLimit of [false, true]) {
        for (const scheduledWattsPerWindow of windowSets) {
          cases++;
          const caseLabel = `soc ${soc} V ${voltage} hitLimit ${hitLimit} windows [${scheduledWattsPerWindow}]`;
          const expected = originalMemoBody({ soc, voltage, hitLimit, scheduledWattsPerWindow });
          const decision = decideSellExport({
            ...sellLimits,
            scheduledWattsPerWindow,
            soc,
            voltage,
            hitLimit,
            sellingStoppedForOverheat: false,
          });
          if (decision.exportWatts !== expected.exportWatts || decision.hitLimit !== expected.hitLimit) {
            mismatches.push(caseLabel);
          }
          const stopped = decideSellExport({
            ...sellLimits,
            scheduledWattsPerWindow,
            soc,
            voltage,
            hitLimit,
            sellingStoppedForOverheat: true,
          });
          if (
            stopped.exportWatts !== 0 ||
            stopped.withheldForOverheatWatts !== expected.exportWatts ||
            stopped.hitLimit !== expected.hitLimit
          ) {
            stoppedMismatches.push(caseLabel);
          }
        }
      }
    }
  }
  return { cases, mismatches, stoppedMismatches };
}

/**
 * shouldSellPower's export memo body as it stood before the extraction (c5d431b), verbatim apart
 * from taking its inputs as parameters and returning the hitLimit it used to assign.
 */
function originalMemoBody(input: {
  soc: number;
  voltage: number;
  hitLimit: boolean;
  scheduledWattsPerWindow: number[];
}): { exportWatts: number; hitLimit: boolean } {
  let hitLimit = input.hitLimit;
  const socLimitToUse = hitLimit ? sellLimits.start_selling_again_above_soc : sellLimits.only_sell_above_soc;
  const voltageLimitToUse = hitLimit
    ? sellLimits.start_selling_again_above_voltage
    : sellLimits.only_sell_above_voltage;
  let result = Math.max(...input.scheduledWattsPerWindow);
  if (Math.abs(result) === Infinity) {
    result = 0;
  }
  if (input.soc > socLimitToUse && input.voltage > voltageLimitToUse) {
    hitLimit = false;
    return { exportWatts: result, hitLimit };
  } else if (result) {
    hitLimit = true;
  }
  return { exportWatts: 0, hitLimit };
}
