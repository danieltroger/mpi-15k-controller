/**
 * Pure self-test of automatic grid-off's decisions (autoGridOffDecisions.ts): every rule, the hysteresis edges
 * of the full and low SOC rules, the window lead, the auto_min_off_minutes stretch, the energy-settings guard,
 * the retry back-off after a failed switch, the switch's own refusal, the next switch the schedule makes known,
 * and the auto_* knobs' correction and merge. No hardware, no clock. Run from backend/ with:
 *   yarn node src/gridOff/autoGridOff.selftest.ts
 */
import process from "process";
import { default_config, mergeWithDefaults } from "../config/config.ts";
import type { Config, GridOffConfig } from "../config/config.types.ts";
import { DEFAULT_GRID_OFF_SETTINGS, effectiveGridOffSettings } from "./gridOffSettings.ts";
import { type ScheduleWindows, scheduledWindows } from "./gridOffDecisions.ts";
import {
  AUTO_SWITCH_OFF_RETRY_INTERVALS_MS,
  type AutoGridOffDecision,
  type AutoGridOffSituation,
  autoGridOffDecision,
  autoRetryBlockedUntilMs,
  expectedNextSwitch,
  NO_OFF_GRID_FAILURES,
  nextOffGridOpportunity,
} from "./autoGridOffDecisions.ts";

const fails: string[] = [];
function check(name: string, condition: boolean, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}: ${name} ${detail}`);
  if (!condition) fails.push(name);
}

const MINUTE_MS = 60_000;
// 23:00 Swedish time (CET in November)
const NOW_MS = Date.parse("2026-11-05T22:00:00Z");
const settings: GridOffConfig = { ...DEFAULT_GRID_OFF_SETTINGS, auto_enabled: true };

function buyWindowAt(startOffsetMinutes: number, durationMinutes: number): ScheduleWindows {
  return {
    [new Date(NOW_MS + startOffsetMinutes * MINUTE_MS).toISOString()]: {
      end_time: new Date(NOW_MS + (startOffsetMinutes + durationMinutes) * MINUTE_MS).toISOString(),
    },
  };
}

/** A quiet night at 60 % on the grid, nothing scheduled, the switch willing */
function situation(overrides: Partial<AutoGridOffSituation> = {}): AutoGridOffSituation {
  return {
    nowMs: NOW_MS,
    soc: 60,
    offGridRequested: false,
    windows: [],
    switchRefusal: undefined,
    energySettingsRestoring: false,
    retryBlockedUntilMs: undefined,
    ...overrides,
  };
}

function withBuyWindow(
  startOffsetMinutes: number,
  durationMinutes: number,
  overrides: Partial<AutoGridOffSituation> = {}
) {
  return situation({
    windows: scheduledWindows({}, buyWindowAt(startOffsetMinutes, durationMinutes), NOW_MS),
    ...overrides,
  });
}

function decide(overrides: Partial<AutoGridOffSituation> = {}): AutoGridOffDecision {
  return autoGridOffDecision(situation(overrides), settings);
}

// ---------- the default: off the grid ----------
{
  const quiet = decide();
  check("a quiet night at 60 %: off the grid (151)", quiet.model === "151" && quiet.kind === "off_grid", quiet.reason);
  const staying = decide({ offGridRequested: true });
  check("…and it stays off", staying.model === "151" && staying.kind === "off_grid");
}

// ---------- (a) the battery full, with its hysteresis ----------
{
  check("off the grid at 94.9 %: stays off", decide({ offGridRequested: true, soc: 94.9 }).model === "151");
  const full = decide({ offGridRequested: true, soc: 95 });
  check(
    "off the grid at 95 %: back on (auto_full_soc_percent)",
    full.model === "050" && full.kind === "battery_full" && full.reason.includes("95 % ≥ 95 %"),
    full.reason
  );
  const shown = decide({ offGridRequested: true, soc: 96.7 });
  check("…the reason reads 'battery 96 % ≥ 95 %'", shown.reason.startsWith("battery 96 % ≥ 95 %"), shown.reason);
  const hovering = decide({ soc: 92 });
  check(
    "on the grid at 92 %: stays on (off again only below 90 %)",
    hovering.model === "050" && hovering.kind === "battery_above_resume" && hovering.reason.includes("below 90 %"),
    hovering.reason
  );
  check("on the grid at exactly 90 %: still on", decide({ soc: 90 }).kind === "battery_above_resume");
  check("on the grid at 89.9 %: off again", decide({ soc: 89.9 }).model === "151");
  check("on the grid at 99 %: 'battery full', not the resume rule", decide({ soc: 99 }).kind === "battery_full");
}

// ---------- (c) the battery low, with its hysteresis ----------
{
  const low = decide({ offGridRequested: true, soc: 9.9 });
  check(
    "off the grid below 10 %: back on (min_soc_percent)",
    low.model === "050" && low.kind === "battery_low" && low.reason.includes("< 10 %"),
    low.reason
  );
  check("off the grid at exactly 10 %: stays off", decide({ offGridRequested: true, soc: 10 }).model === "151");
  const recovering = decide({ soc: 14.9 });
  check(
    "on the grid at 14.9 %: stays on (off again from 10 + 5 %)",
    recovering.model === "050" && recovering.kind === "battery_low" && recovering.reason.includes("< 15 %"),
    recovering.reason
  );
  check("on the grid at 15 %: off again", decide({ soc: 15 }).model === "151");
  const unknown = decide({ soc: undefined, offGridRequested: true });
  check("an unknown SOC: on the grid, either way", unknown.model === "050" && unknown.kind === "soc_unknown");
  check("…also when switching on", decide({ soc: undefined }).kind === "soc_unknown");
}

// ---------- (b) the window lead ----------
{
  const soon = autoGridOffDecision(withBuyWindow(10, 60, { offGridRequested: true }), settings);
  check(
    "off the grid, a buy window starting in 10 min: back on",
    soon.model === "050" && soon.kind === "window" && soon.reason.includes("buy window at 23:10 starts within 10 min"),
    soon.reason
  );
  const justOutside = autoGridOffDecision(withBuyWindow(10.5, 60, { offGridRequested: true }), settings);
  check("…in 10.5 min: still off (the lead is 10 min)", justOutside.model === "151");
  const active = autoGridOffDecision(withBuyWindow(-30, 60, { offGridRequested: true }), settings);
  check(
    "an active window: on the grid, said with its times",
    active.kind === "window" && active.reason.includes("is on (22:30 → 23:30)"),
    active.reason
  );
  const ended = autoGridOffDecision(withBuyWindow(-60, 60), settings);
  check("a window that ended: off the grid", ended.model === "151");
  const sell = autoGridOffDecision(situation({ windows: scheduledWindows(buyWindowAt(5, 30), {}, NOW_MS) }), settings);
  check("a sell window counts too", sell.kind === "window" && sell.reason.includes("sell window"), sell.reason);
  const zeroWatt = autoGridOffDecision(
    situation({
      windows: scheduledWindows(
        {},
        { [new Date(NOW_MS + 5 * MINUTE_MS).toISOString()]: { end_time: "garbage" } },
        NOW_MS
      ),
    }),
    settings
  );
  check("an entry whose end doesn't parse is skipped (as the buy logic does)", zeroWatt.model === "151");
  const windowBeatsFull = autoGridOffDecision(withBuyWindow(5, 30, { soc: 97 }), settings);
  check("a window is named before a full battery", windowBeatsFull.kind === "window");
}

// ---------- (d) the stretch before the next window's reconnect ----------
{
  // Reconnect at window start − 10 min: a window in 70 min leaves exactly 60 min
  const exactly = autoGridOffDecision(withBuyWindow(70, 60), settings);
  check("a window in 70 min (60 min before its reconnect): off the grid", exactly.model === "151", exactly.reason);
  const short = autoGridOffDecision(withBuyWindow(69, 60), settings);
  check(
    "a window in 69 min (59 min): stays on the grid",
    short.model === "050" &&
      short.kind === "short_stretch" &&
      short.reason.includes("only 59 min") &&
      short.reason.includes("buy window at 2026-11-06 00:09"),
    short.reason
  );
  const alreadyOff = autoGridOffDecision(withBuyWindow(30, 60, { offGridRequested: true }), settings);
  check(
    "off the grid already, a window in 30 min: stays off until the lead (no SOC/stretch prediction)",
    alreadyOff.model === "151"
  );
  const longer = autoGridOffDecision(withBuyWindow(69, 60), { ...settings, auto_min_off_minutes: 30 });
  check("auto_min_off_minutes 30: the 59 min stretch is long enough", longer.model === "151");
}

// ---------- (f) the energy settings, (e) the switch's refusal, the retry back-off ----------
{
  const restoring = decide({ energySettingsRestoring: true });
  check(
    "the 050 profile being written back: stays on the grid",
    restoring.model === "050" && restoring.kind === "energy_settings"
  );
  check(
    "…but it doesn't pull an off-grid inverter back",
    decide({ energySettingsRestoring: true, offGridRequested: true }).model === "151"
  );
  const refused = decide({ switchRefusal: "the inverter readings (GS/PS) are 75 s old (over 60 s)" });
  check(
    "the switch would refuse: on the grid, with its reason",
    refused.model === "050" && refused.kind === "switch_refused" && refused.reason.includes("75 s old")
  );
  const blocked = decide({ retryBlockedUntilMs: NOW_MS + 4 * MINUTE_MS });
  check(
    "a failed switch-off holds the next try back",
    blocked.model === "050" && blocked.kind === "retry_backoff" && blocked.reason.includes("23:04"),
    blocked.reason
  );
  check("…until its time", decide({ retryBlockedUntilMs: NOW_MS }).model === "151");
  check(
    "a short stretch is named before the energy settings and the refusal",
    autoGridOffDecision(withBuyWindow(30, 60, { energySettingsRestoring: true, switchRefusal: "x" }), settings).kind ===
      "short_stretch"
  );
  check(
    "the energy settings before a refusal (that refusal clears by itself)",
    decide({ energySettingsRestoring: true, switchRefusal: "the last switch was 10 s ago" }).kind === "energy_settings"
  );
}

// ---------- the retry back-off ----------
{
  check("no failure: nothing held back", autoRetryBlockedUntilMs(NO_OFF_GRID_FAILURES) === undefined);
  const intervals = [1, 2, 3, 4, 7].map(count => (autoRetryBlockedUntilMs({ count, lastAtMs: NOW_MS }) ?? 0) - NOW_MS);
  check(
    "5, 15, then 60 min after the 1st, 2nd and every later failure",
    intervals.join(",") ===
      [
        AUTO_SWITCH_OFF_RETRY_INTERVALS_MS[0],
        AUTO_SWITCH_OFF_RETRY_INTERVALS_MS[1],
        AUTO_SWITCH_OFF_RETRY_INTERVALS_MS[2],
        AUTO_SWITCH_OFF_RETRY_INTERVALS_MS[2],
        AUTO_SWITCH_OFF_RETRY_INTERVALS_MS[2],
      ].join(",") && AUTO_SWITCH_OFF_RETRY_INTERVALS_MS.join(",") === "300000,900000,3600000",
    intervals.join(",")
  );
}

// ---------- the next switch ----------
{
  const offGridSituation = withBuyWindow(120, 60);
  const offDecision = autoGridOffDecision(offGridSituation, settings);
  const reconnect = expectedNextSwitch(offDecision, offGridSituation, settings);
  check(
    "off the grid: next, the reconnect 10 min before the window at 01:00",
    reconnect?.model === "050" && reconnect.at === NOW_MS + 110 * MINUTE_MS && reconnect.why.includes("01:00"),
    JSON.stringify(reconnect)
  );
  check(
    "off the grid with nothing scheduled: none known",
    expectedNextSwitch(decide(), situation(), settings) === undefined
  );
  const windowSituation = withBuyWindow(5, 60);
  const afterWindow = expectedNextSwitch(autoGridOffDecision(windowSituation, settings), windowSituation, settings);
  check(
    "on the grid for a window: next, off at its end",
    afterWindow?.model === "151" && afterWindow.at === NOW_MS + 65 * MINUTE_MS && afterWindow.why.includes("00:05"),
    JSON.stringify(afterWindow)
  );
  check(
    "on the grid for the battery: none known",
    expectedNextSwitch(decide({ soc: 92 }), situation({ soc: 92 }), settings) === undefined
  );
  const blockedSituation = situation({ retryBlockedUntilMs: NOW_MS + 3 * MINUTE_MS });
  check(
    "held back after a failure: the next try",
    expectedNextSwitch(autoGridOffDecision(blockedSituation, settings), blockedSituation, settings)?.at ===
      NOW_MS + 3 * MINUTE_MS
  );
}

// ---------- the next off-grid opportunity across chained windows ----------
{
  const windows = scheduledWindows(
    {},
    { ...buyWindowAt(0, 60), ...buyWindowAt(60, 30), ...buyWindowAt(130, 60), ...buyWindowAt(400, 30) },
    NOW_MS
  );
  const opportunity = nextOffGridOpportunity(windows, NOW_MS, 10 * MINUTE_MS, 60 * MINUTE_MS);
  // Ends at 90 (next at 130: 30 min, too short), 190 (next at 400: 200 min) → 190
  check(
    "chained windows and a short gap are skipped: the first end with 60 min before the next reconnect",
    opportunity?.atMs === NOW_MS + 190 * MINUTE_MS && opportunity.afterWindow?.endMs === NOW_MS + 190 * MINUTE_MS,
    String(((opportunity?.atMs ?? 0) - NOW_MS) / MINUTE_MS)
  );
  check("nothing scheduled: now", nextOffGridOpportunity([], NOW_MS, 10 * MINUTE_MS, 60 * MINUTE_MS)?.atMs === NOW_MS);
}

// ---------- the knobs ----------
{
  const { settings: defaults, corrections } = effectiveGridOffSettings(DEFAULT_GRID_OFF_SETTINGS);
  check(
    "the auto defaults (off, 95 %, 90 %, 60 min) pass uncorrected",
    !defaults.auto_enabled &&
      defaults.auto_full_soc_percent === 95 &&
      defaults.auto_resume_soc_percent === 90 &&
      defaults.auto_min_off_minutes === 60 &&
      corrections.length === 0
  );
  const inverted = effectiveGridOffSettings({
    ...DEFAULT_GRID_OFF_SETTINGS,
    auto_full_soc_percent: 80,
    auto_resume_soc_percent: 85,
  });
  check(
    "resume at or above full is corrected to just below it, with a correction",
    inverted.settings.auto_resume_soc_percent === 79 &&
      inverted.settings.auto_full_soc_percent === 80 &&
      inverted.corrections.length === 1 &&
      inverted.corrections[0]!.includes("auto_resume_soc_percent"),
    inverted.corrections.join("; ")
  );
  const equal = effectiveGridOffSettings({ ...DEFAULT_GRID_OFF_SETTINGS, auto_full_soc_percent: 90 });
  check("…also when equal", equal.settings.auto_resume_soc_percent === 89);
  const clamped = effectiveGridOffSettings({
    ...DEFAULT_GRID_OFF_SETTINGS,
    auto_full_soc_percent: 120,
    auto_resume_soc_percent: 10,
    auto_min_off_minutes: 5,
  });
  check(
    "out-of-bounds auto knobs are clamped (100 %, 40 %, 15 min)",
    clamped.settings.auto_full_soc_percent === 100 &&
      clamped.settings.auto_resume_soc_percent === 40 &&
      clamped.settings.auto_min_off_minutes === 15 &&
      clamped.corrections.length === 3,
    clamped.corrections.join("; ")
  );
  const notBoolean = effectiveGridOffSettings({ ...DEFAULT_GRID_OFF_SETTINGS, auto_enabled: "yes" });
  check(
    "auto_enabled that isn't true/false is off, with a correction",
    !notBoolean.settings.auto_enabled && notBoolean.corrections.length === 1
  );
  // A config.json from before automatic grid-off: grid_off has only #87's keys
  const { auto_enabled, auto_full_soc_percent, auto_resume_soc_percent, auto_min_off_minutes, ...olderGridOff } =
    default_config.grid_off;
  const merged = mergeWithDefaults({ grid_off: { ...olderGridOff, min_soc_percent: 20 } } as Partial<Config>);
  check(
    "an older grid_off picks up the auto defaults key by key (and keeps its own values)",
    merged.grid_off.auto_enabled === false &&
      merged.grid_off.auto_full_soc_percent === 95 &&
      merged.grid_off.auto_resume_soc_percent === 90 &&
      merged.grid_off.auto_min_off_minutes === 60 &&
      merged.grid_off.min_soc_percent === 20 &&
      effectiveGridOffSettings(merged.grid_off).corrections.length === 0,
    JSON.stringify({ auto_enabled, auto_full_soc_percent, auto_resume_soc_percent, auto_min_off_minutes })
  );
  const olderTrading = { ...default_config.automatic_trading } as Partial<Config["automatic_trading"]>;
  delete olderTrading.grid_off_saving_watts;
  check(
    "an older automatic_trading picks up grid_off_saving_watts (45 W)",
    mergeWithDefaults({ automatic_trading: olderTrading } as Partial<Config>).automatic_trading
      .grid_off_saving_watts === 45
  );
}

console.log(`\n${fails.length ? `${fails.length} FAILED: ${fails.join(", ")}` : "all autoGridOff selftests passed"}`);
process.exit(fails.length ? 1 : 0);
