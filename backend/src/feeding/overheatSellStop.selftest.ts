/**
 * Self-test for the overheat sell stop: the 97/90 °C hysteresis, staleness holds, and what a live
 * sell window exports through an overheat. Run from backend/ with:
 *   yarn node src/feeding/overheatSellStop.selftest.ts
 *
 * The temperature traces follow the 2025-06-30 shape: ~14 kW selling, ventilation shut, the inverter
 * climbing towards its 100 °C fault-57 latch.
 */
import process from "process";
import {
  MAX_TEMPERATURE_READING_AGE_MS,
  OVERHEAT_SELL_STOP_BOOT_STATE,
  type OverheatSellStopState,
  stepOverheatSellStop,
} from "./overheatSellStop.ts";
import { decideSellExport } from "./sellExportDecision.ts";
import { describeOverheatSellResume, describeOverheatSellStop } from "../alerting/overheatSellStopAlerts.ts";
import { default_config, mergeWithDefaults } from "../config/config.ts";
import type { Config } from "../config/config.types.ts";

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

const limits = {
  only_sell_below_inverter_temp_celsius: 97,
  start_selling_again_below_inverter_temp_celsius: 90,
};
const sellLimits = {
  only_sell_above_soc: 13,
  start_selling_again_above_soc: 25,
  only_sell_above_voltage: 49.8,
  start_selling_again_above_voltage: 52.2,
};
const nowMs = 1_751_300_000_000;
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

// ——— a live 14 kW sell window through an overheat ———
const windowWatts = 14_000;
const overheatTrace = [88, 94, 96.8, 97.1, 96.9, 97.3, 95, 92, 90.4, 90, 89.8, 90.3, 91, 93];
const overheatRun = runSellTicks(overheatTrace.map(temperatureCelsius => ({ temperatureCelsius })));
check(
  "window exports 14 kW, 0 from ≥97 °C until <90 °C, then 14 kW again",
  overheatRun.exportWatts,
  [14000, 14000, 14000, 0, 0, 0, 0, 0, 0, 0, 14000, 14000, 14000, 14000]
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
  "no schedule entries export 0 (Math.max of nothing)",
  decideSellExport({
    ...sellLimits,
    scheduledWattsPerWindow: [],
    soc: 60,
    voltage: 53,
    hitLimit: false,
    sellingStoppedForOverheat: false,
  }),
  { exportWatts: 0, hitLimit: false }
);
check(
  "overlapping windows: the biggest one wins",
  decideSellExport({
    ...sellLimits,
    scheduledWattsPerWindow: [0, 9000, 14000],
    soc: 60,
    voltage: 53,
    hitLimit: false,
    sellingStoppedForOverheat: false,
  }).exportWatts,
  14000
);

// ——— alert text ———
const stopAlert = describeOverheatSellStop(97.24, limits);
check("P1 on stop under the pre-existing key", [stopAlert.severity, stopAlert.key], ["P1", "inverter-temp"]);
check(
  "P1 says selling stopped, that it is too hot, and what to check",
  ["selling stopped", "97.2°C", "below 90°C", "100°C", "door", "ventilation"].filter(
    phrase => !(stopAlert.title + " " + stopAlert.message).includes(phrase)
  ),
  []
);
const resumeAlert = describeOverheatSellResume(89.86, limits);
check("quiet P3 on resume", [resumeAlert.severity, resumeAlert.key], ["P3", "inverter-temp:resolved"]);
check(
  "P3 says selling resumed and quotes the reading",
  ["selling resumed", "89.9°C"].filter(phrase => !(resumeAlert.title + " " + resumeAlert.message).includes(phrase)),
  []
);

// ——— config: a config.json written before these knobs existed must still stop selling ———
const { only_sell_below_inverter_temp_celsius, start_selling_again_below_inverter_temp_celsius, ...olderSelling } =
  default_config.scheduled_power_selling;
const storedBeforeTheKnobs: Partial<Config> = {
  ...structuredClone(default_config),
  // The cast is the point: this is the shape config.json files on disk still have
  scheduled_power_selling: { ...olderSelling, schedule: {} } as Config["scheduled_power_selling"],
};
const healed = mergeWithDefaults(storedBeforeTheKnobs).scheduled_power_selling;
check(
  "an older stored scheduled_power_selling picks up the temperature limits",
  [healed.only_sell_below_inverter_temp_celsius, healed.start_selling_again_below_inverter_temp_celsius],
  [only_sell_below_inverter_temp_celsius, start_selling_again_below_inverter_temp_celsius]
);
check("…without resurrecting the default's sample sell window", Object.keys(healed.schedule), []);

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

type SellTick = {
  temperatureCelsius: number;
  readingAgeMs?: number;
  /** Defaults to the 14 kW window being active */
  scheduledWatts?: number;
  soc?: number;
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
  const result = { exportWatts: [] as number[], stopFlips: 0, resumeFlips: 0, exportChanges: 0 };
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
      voltage: 53,
      hitLimit,
      sellingStoppedForOverheat: overheatState.sellingStopped,
    });
    hitLimit = decision.hitLimit;
    if (previousExportWatts !== undefined && decision.exportWatts !== previousExportWatts) result.exportChanges++;
    previousExportWatts = decision.exportWatts;
    result.exportWatts.push(decision.exportWatts);
  }
  return result;
}
