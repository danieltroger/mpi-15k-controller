/**
 * Self-test for the overheat sell stop's alerts: the live effect run inside a createRoot against a
 * manager that applies the real per-key cooldown (decideSend) and keeps a recentAlerts history like
 * alert_state.json, across simulated restarts — plus the alert texts. Run from backend/ with:
 *   yarn node src/alerting/overheatSellStopAlerts.selftest.ts
 */
import process from "process";
import { createRoot, createSignal } from "solid-js";
import type { AlertManager } from "./alertManager.ts";
import type { AlertRecord, AlertSeverity } from "./alerting.types.ts";
import { decideSend, expiredCooldownKeys } from "./alertingLogic.ts";
import {
  describeOverheatSellResume,
  describeOverheatSellStop,
  OVERHEAT_ALERT_KEY,
  startOverheatSellStopAlerts,
} from "./overheatSellStopAlerts.ts";
import { default_config } from "../config/config.ts";
import type { Config } from "../config/config.types.ts";
import {
  OVERHEAT_SELL_STOP_BOOT_STATE,
  type OverheatSellStopState,
  stepOverheatSellStop,
} from "../feeding/overheatSellStop.ts";

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

const COOLDOWN_MS = default_config.alerting.cooldown_minutes * 60_000;
const startMs = 1_751_300_000_000;
const minuteMs = 60_000;
const limits = default_config.scheduled_power_selling;
const STOPPED_AT_BOOT: OverheatSellStopState = { sellingStopped: true, flipReading: { value: 97.6, time: startMs } };

// ——— the sawtooth: stop → resume → stop again 28 min after the first page (review of #60) ———
check(
  "a single key would swallow the re-stop: same-severity repeat inside the cooldown",
  decideSend({
    nowMs: startMs + 28 * minuteMs,
    severity: "P1",
    lastSentForKey: { atMs: startMs, severity: "P1" },
    cooldownMs: COOLDOWN_MS,
    pushedAtMsLastHour: [],
    maxPushesPerHour: 20,
  }),
  "cooldown"
);
const sawtooth = createAlertHarness({ initialState: OVERHEAT_SELL_STOP_BOOT_STATE });
sawtooth.setWithheldSellWatts(14000);
flip(sawtooth, true, 97.2, startMs);
flip(sawtooth, false, 89.8, startMs + 12 * minuteMs);
flip(sawtooth, true, 97.1, startMs + 28 * minuteMs);
flip(sawtooth, false, 89.6, startMs + 41 * minuteMs);
check("stop → resume → stop within 28 min pages twice, every edge delivered", summarize(sawtooth.raised), [
  ["P1", OVERHEAT_ALERT_KEY, "pushed"],
  ["P3", `${OVERHEAT_ALERT_KEY}:resolved`, "pushed"],
  ["P1", `${OVERHEAT_ALERT_KEY}:${startMs + 28 * minuteMs}`, "pushed"],
  ["P3", `${OVERHEAT_ALERT_KEY}:${startMs + 28 * minuteMs}:resolved`, "pushed"],
]);
check(
  "the alert sequence never ends on an all-clear: each resume notice says so",
  sawtooth.raised.filter(record => record.severity === "P3").map(record => record.message.includes("Not an all-clear")),
  [true, true]
);
check(
  "episode keys age out of alert_state.json like inverter-stuck:<onset> keys",
  expiredCooldownKeys(
    new Map([
      [`${OVERHEAT_ALERT_KEY}:${startMs}`, { atMs: startMs }],
      [`${OVERHEAT_ALERT_KEY}:${startMs + 7 * 86_400_000}`, { atMs: startMs + 7 * 86_400_000 }],
    ]),
    startMs + 7 * 86_400_000 + 1,
    COOLDOWN_MS
  ),
  [`${OVERHEAT_ALERT_KEY}:${startMs}`]
);
sawtooth.dispose();

// ——— restarts (review of b88c4b9): two roots in sequence sharing one alert_state.json ———
const beforeRestart = createAlertHarness({ initialState: OVERHEAT_SELL_STOP_BOOT_STATE });
beforeRestart.setWithheldSellWatts(14000);
flip(beforeRestart, true, 97.2, startMs);
flip(beforeRestart, false, 89.8, startMs + 12 * minuteMs);
beforeRestart.dispose(); // systemctl restart / main() crash at +15 min
const afterRestart = createAlertHarness({
  initialState: OVERHEAT_SELL_STOP_BOOT_STATE,
  persisted: beforeRestart.persisted,
  startedAtMs: startMs + 15 * minuteMs,
});
afterRestart.setWithheldSellWatts(14000);
flip(afterRestart, true, 97.1, startMs + 28 * minuteMs);
flip(afterRestart, false, 89.4, startMs + 40 * minuteMs);
check(
  "a restart between the resume and the re-stop still pages the P1 the resume notice promised",
  summarize(afterRestart.raised),
  [
    ["P1", `${OVERHEAT_ALERT_KEY}:${startMs + 28 * minuteMs}`, "pushed"],
    ["P3", `${OVERHEAT_ALERT_KEY}:${startMs + 28 * minuteMs}:resolved`, "pushed"],
  ]
);
afterRestart.dispose();

const firstBoot = createAlertHarness({ initialState: STOPPED_AT_BOOT });
const crashLoopRaises = [...firstBoot.raised];
let crashLoopPersisted = firstBoot.persisted;
firstBoot.dispose();
for (let restartIndex = 1; restartIndex <= 4; restartIndex++) {
  // main() restarts 10 s after a crash; the inverter is still at 97+ °C on every boot
  const rebooted = createAlertHarness({
    initialState: STOPPED_AT_BOOT,
    persisted: crashLoopPersisted,
    startedAtMs: startMs + restartIndex * minuteMs,
  });
  crashLoopRaises.push(...rebooted.raised);
  crashLoopPersisted = rebooted.persisted;
  rebooted.dispose();
}
check(
  "a crash loop mid-overheat keeps the plain key and pages once: the cooldown holds the rest",
  summarize(crashLoopRaises),
  [
    ["P1", OVERHEAT_ALERT_KEY, "pushed"],
    ["P1", OVERHEAT_ALERT_KEY, "cooldown"],
    ["P1", OVERHEAT_ALERT_KEY, "cooldown"],
    ["P1", OVERHEAT_ALERT_KEY, "cooldown"],
    ["P1", OVERHEAT_ALERT_KEY, "cooldown"],
  ]
);

const repeatEpisode = createAlertHarness({ initialState: OVERHEAT_SELL_STOP_BOOT_STATE });
flip(repeatEpisode, true, 97.2, startMs);
flip(repeatEpisode, false, 89.8, startMs + 12 * minuteMs);
flip(repeatEpisode, true, 97.1, startMs + 28 * minuteMs);
repeatEpisode.dispose();
const repeatEpisodeRebooted = createAlertHarness({
  initialState: { sellingStopped: true, flipReading: { value: 97.4, time: startMs + 30 * minuteMs } },
  persisted: repeatEpisode.persisted,
  startedAtMs: startMs + 30 * minuteMs,
});
check(
  "a crash inside a repeat episode continues that episode's key, so its cooldown holds too",
  summarize(repeatEpisodeRebooted.raised),
  [["P1", `${OVERHEAT_ALERT_KEY}:${startMs + 28 * minuteMs}`, "cooldown"]]
);
repeatEpisodeRebooted.dispose();

// ——— a misordered pair must not page in a loop: the stop cools the reading a degree, the resume
// heats it back (review of b88c4b9: zero-width band → 15 P1/h). Integer readings dither at the stop
// limit every 2 min for an hour. ———
for (const [label, stopLimitCelsius, resumeLimitCelsius] of [
  ["equal 97/97", 97, 97],
  ["swapped 90/95", 90, 95],
  ["migrated old P1 threshold 88 vs default resume 90", 88, 90],
  ["default 97/90", 97, 90],
] as const) {
  const ditherConfig: Config = {
    ...default_config,
    scheduled_power_selling: {
      ...default_config.scheduled_power_selling,
      only_sell_below_inverter_temp_celsius: stopLimitCelsius,
      start_selling_again_below_inverter_temp_celsius: resumeLimitCelsius,
    },
  };
  const dither = createAlertHarness({ initialState: OVERHEAT_SELL_STOP_BOOT_STATE, config: ditherConfig });
  dither.setWithheldSellWatts(14000);
  let state = OVERHEAT_SELL_STOP_BOOT_STATE;
  for (let minute = 0; minute < 60; minute += 2) {
    const roundAtMs = startMs + minute * minuteMs;
    const temperatureCelsius = (minute / 2) % 2 === 0 ? stopLimitCelsius : stopLimitCelsius - 1;
    state = stepOverheatSellStop({
      ...ditherConfig.scheduled_power_selling,
      previousState: state,
      reading: { value: temperatureCelsius, time: roundAtMs },
      nowMs: roundAtMs,
    });
    dither.clock.nowMs = roundAtMs;
    dither.setState(state);
  }
  const pushedP1Count = dither.raised.filter(record => record.severity === "P1" && record.delivery === "pushed").length;
  check(`dithering at the stop limit for an hour (${label}) pages at most one P1`, pushedP1Count <= 1, true);
  dither.dispose();
}

// ——— edges only ———
const alreadyStopped = createAlertHarness({ initialState: STOPPED_AT_BOOT });
check(
  "a stop already in force when alerting starts pages, under the plain key on a fresh history",
  summarize(alreadyStopped.raised),
  [["P1", OVERHEAT_ALERT_KEY, "pushed"]]
);
flip(alreadyStopped, true, 98.4, startMs + minuteMs);
alreadyStopped.setState(OVERHEAT_SELL_STOP_BOOT_STATE);
check("a new state object that flips nothing raises nothing", alreadyStopped.raised.length, 1);
alreadyStopped.dispose();

const quietBoot = createAlertHarness({ initialState: OVERHEAT_SELL_STOP_BOOT_STATE });
check("boot state raises nothing", quietBoot.raised.length, 0);
quietBoot.dispose();

// ——— wording by whether anything was curtailed ———
const noWindow = createAlertHarness({ initialState: OVERHEAT_SELL_STOP_BOOT_STATE });
flip(noWindow, true, 97.4, startMs);
const noWindowAlert = noWindow.raised[0];
check(
  "no sell window exporting: the P1 says nothing was curtailed instead of claiming the mitigation worked",
  [
    noWindowAlert?.title,
    noWindowAlert?.message.includes("curtails nothing"),
    noWindowAlert?.message.includes("selling stopped"),
  ],
  ["Inverter overheating", true, false]
);
noWindow.dispose();

const stopAlert = describeOverheatSellStop({
  ...limits,
  episodeKey: OVERHEAT_ALERT_KEY,
  temperatureCelsius: 97.24,
  withheldSellWatts: 14000,
});
check(
  "curtailing P1 says selling stopped, that it is too hot, and what to check",
  ["selling stopped", "97.2°C", "14000 W", "below 90°C", "100°C", "door", "ventilation"].filter(
    phrase => !(stopAlert.title + " " + stopAlert.message).includes(phrase)
  ),
  []
);
check(
  "with a swapped pair the P1 quotes where selling really resumes (7 °C below the stop limit)",
  describeOverheatSellStop({
    only_sell_below_inverter_temp_celsius: 90,
    start_selling_again_below_inverter_temp_celsius: 95,
    episodeKey: OVERHEAT_ALERT_KEY,
    temperatureCelsius: 90,
    withheldSellWatts: 14000,
  }).message.includes("cools below 83°C"),
  true
);
const resumeAlert = describeOverheatSellResume({
  ...limits,
  episodeKey: OVERHEAT_ALERT_KEY,
  temperatureCelsius: 89.86,
});
check("quiet P3 on resume", [resumeAlert.severity, resumeAlert.key], ["P3", `${OVERHEAT_ALERT_KEY}:resolved`]);
check(
  "P3 says selling resumed, quotes the reading, and warns it will stop again at 97 °C",
  ["selling resumed", "89.9°C", "Not an all-clear", "97°C"].filter(
    phrase => !(resumeAlert.title + " " + resumeAlert.message).includes(phrase)
  ),
  []
);

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll overheat sell stop alert checks passed");

/** What alert_state.json carries across a restart: the cooldown map and the newest-first recent list */
type PersistedAlerts = {
  recentNewestFirst: AlertRecord[];
  lastSentByKey: Map<string, { atMs: number; severity: AlertSeverity }>;
};

/**
 * The live effect in a root of its own — one "process" — against a manager that applies the real
 * per-key cooldown at the harness's simulated clock and, like alertManager.raise, records only sent
 * alerts in recentAlerts (a cooldown-swallowed raise returns early). Pass the previous harness's
 * `persisted` to simulate a restart.
 */
function createAlertHarness(options: {
  initialState: OverheatSellStopState;
  persisted?: PersistedAlerts;
  config?: Config;
  startedAtMs?: number;
}) {
  const persisted: PersistedAlerts = options.persisted ?? { recentNewestFirst: [], lastSentByKey: new Map() };
  const [state, setState] = createSignal(options.initialState);
  const [withheldSellWatts, setWithheldSellWatts] = createSignal(0);
  /** Every raise this process made, including the ones the cooldown swallowed */
  const raised: AlertRecord[] = [];
  const clock = { nowMs: options.startedAtMs ?? startMs };
  const harnessConfig = options.config ?? default_config;
  const manager: AlertManager = {
    recentAlerts: () => persisted.recentNewestFirst,
    raise: async alert => {
      const decision = decideSend({
        nowMs: clock.nowMs,
        severity: alert.severity,
        lastSentForKey: persisted.lastSentByKey.get(alert.key),
        cooldownMs: COOLDOWN_MS,
        pushedAtMsLastHour: [],
        maxPushesPerHour: 20,
      });
      const record: AlertRecord = {
        ...alert,
        at: new Date(clock.nowMs).toISOString(),
        delivery: decision === "send" ? "pushed" : decision,
      };
      if (decision === "send") {
        persisted.lastSentByKey.set(alert.key, { atMs: clock.nowMs, severity: alert.severity });
        persisted.recentNewestFirst.unshift(record);
      }
      raised.push(record);
      return record;
    },
  };
  const dispose = createRoot(disposeRoot => {
    startOverheatSellStopAlerts({
      config: () => harnessConfig,
      manager,
      overheatSellStop: { state, withheldSellWatts },
    });
    return disposeRoot;
  });
  return { raised, persisted, clock, setState, setWithheldSellWatts, dispose };
}

function flip(
  harness: ReturnType<typeof createAlertHarness>,
  sellingStopped: boolean,
  temperatureCelsius: number,
  atMs: number
) {
  harness.clock.nowMs = atMs;
  harness.setState({ sellingStopped, flipReading: { value: temperatureCelsius, time: atMs } });
}

function summarize(records: AlertRecord[]) {
  return records.map(record => [record.severity, record.key, record.delivery]);
}
