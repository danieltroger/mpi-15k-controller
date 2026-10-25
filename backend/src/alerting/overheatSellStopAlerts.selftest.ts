/**
 * Self-test for the overheat sell stop's alerts: the live effect run inside a createRoot against a
 * manager that applies the real per-key cooldown (decideSend), plus the alert texts. Run from
 * backend/ with:
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
import { OVERHEAT_SELL_STOP_BOOT_STATE, type OverheatSellStopState } from "../feeding/overheatSellStop.ts";

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
const sawtooth = createAlertHarness(OVERHEAT_SELL_STOP_BOOT_STATE);
sawtooth.setWithheldSellWatts(14000);
flip(sawtooth, true, 97.2, startMs);
flip(sawtooth, false, 89.8, startMs + 12 * minuteMs);
flip(sawtooth, true, 97.1, startMs + 28 * minuteMs);
flip(sawtooth, false, 89.6, startMs + 41 * minuteMs);
check("stop → resume → stop within 28 min pages twice, every edge delivered", summarize(sawtooth.records), [
  ["P1", OVERHEAT_ALERT_KEY, "pushed"],
  ["P3", `${OVERHEAT_ALERT_KEY}:resolved`, "pushed"],
  ["P1", `${OVERHEAT_ALERT_KEY}:${startMs + 28 * minuteMs}`, "pushed"],
  ["P3", `${OVERHEAT_ALERT_KEY}:${startMs + 28 * minuteMs}:resolved`, "pushed"],
]);
check(
  "the alert sequence never ends on an all-clear: each resume notice says so",
  sawtooth.records
    .filter(record => record.severity === "P3")
    .map(record => record.message.includes("Not an all-clear")),
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

// ——— edges only ———
const alreadyStopped = createAlertHarness({ sellingStopped: true, flipReading: { value: 98, time: startMs } });
check(
  "a stop already in force when alerting starts pages, under the stable first-since-boot key",
  summarize(alreadyStopped.records),
  [["P1", OVERHEAT_ALERT_KEY, "pushed"]]
);
flip(alreadyStopped, true, 98.4, startMs + minuteMs);
alreadyStopped.setState(OVERHEAT_SELL_STOP_BOOT_STATE);
check("a new state object that flips nothing raises nothing", alreadyStopped.records.length, 1);
alreadyStopped.dispose();

const quietBoot = createAlertHarness(OVERHEAT_SELL_STOP_BOOT_STATE);
check("boot state raises nothing", quietBoot.records.length, 0);
quietBoot.dispose();

// ——— wording by whether anything was curtailed ———
const noWindow = createAlertHarness(OVERHEAT_SELL_STOP_BOOT_STATE);
flip(noWindow, true, 97.4, startMs);
const noWindowAlert = noWindow.records[0];
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

/**
 * The live effect in a root of its own, against a manager that records every raise and applies the
 * real per-key cooldown at the harness's simulated clock — what alertManager.raise decides, minus IO.
 */
function createAlertHarness(initialState: OverheatSellStopState) {
  const [state, setState] = createSignal(initialState);
  const [withheldSellWatts, setWithheldSellWatts] = createSignal(0);
  const records: AlertRecord[] = [];
  const lastSentByKey = new Map<string, { atMs: number; severity: AlertSeverity }>();
  const clock = { nowMs: startMs };
  const manager: AlertManager = {
    recentAlerts: () => records,
    raise: async alert => {
      const decision = decideSend({
        nowMs: clock.nowMs,
        severity: alert.severity,
        lastSentForKey: lastSentByKey.get(alert.key),
        cooldownMs: COOLDOWN_MS,
        pushedAtMsLastHour: [],
        maxPushesPerHour: 20,
      });
      if (decision === "send") lastSentByKey.set(alert.key, { atMs: clock.nowMs, severity: alert.severity });
      const record: AlertRecord = {
        ...alert,
        at: new Date(clock.nowMs).toISOString(),
        delivery: decision === "send" ? "pushed" : decision,
      };
      records.push(record);
      return record;
    },
  };
  const dispose = createRoot(disposeRoot => {
    startOverheatSellStopAlerts({
      config: () => default_config,
      manager,
      overheatSellStop: { state, withheldSellWatts },
    });
    return disposeRoot;
  });
  return { records, clock, setState, setWithheldSellWatts, dispose };
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
