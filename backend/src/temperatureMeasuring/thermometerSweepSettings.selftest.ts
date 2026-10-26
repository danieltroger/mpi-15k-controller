/**
 * Self-test of the temperature_saving.thermometer_* settings: their defaults (the values the sweep ran with
 * before they were settings), their bounds and corrections, the cadence-aware staleness limit (pure), and the
 * live accessors run inside a createRoot against a config signal: corrected values, one warning per bad value
 * (not one per config write), a log line per change, and the snapshot each sweep runs with. Run from backend/
 * with:
 *   yarn node src/temperatureMeasuring/thermometerSweepSettings.selftest.ts
 */
import process from "process";
import { createRoot, createSignal, type Setter } from "solid-js";
import { default_config } from "../config/config.ts";
import type { Config } from "../config/config.types.ts";
import type { SweepLogger } from "./thermometerSweep.ts";
import {
  DEFAULT_THERMOMETER_SWEEP_SETTINGS,
  effectiveThermometerSweepSetting,
  temperatureStaleAfterMs,
  type ThermometerSweepSettings,
} from "./thermometerSweepSettings.ts";
import {
  currentSweepSettings,
  type LiveThermometerSweepSettings,
  useThermometerSweepSettings,
} from "./useThermometerSweepSettings.ts";

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

type LoggedLine = { level: "log" | "warn" | "error"; text: string };

type SettingsHarness = {
  liveSettings: LiveThermometerSweepSettings;
  lines: LoggedLine[];
  setConfig: Setter<Config>;
  stop: () => void;
};

const minuteMs = 60_000;

// ——— the defaults are what the sweep ran with when these were constants, so deploying changes nothing ———
check(
  "defaults: 10 s sweeps, a silent probe pages after 5 min, the bulk read is retried every 60 s",
  DEFAULT_THERMOMETER_SWEEP_SETTINGS,
  {
    thermometer_sweep_interval_seconds: 10,
    thermometer_silent_page_after_minutes: 5,
    thermometer_bulk_retry_interval_seconds: 60,
  }
);
check(
  "defaults: config.json without the keys gets them",
  [
    default_config.temperature_saving.thermometer_sweep_interval_seconds,
    default_config.temperature_saving.thermometer_silent_page_after_minutes,
    default_config.temperature_saving.thermometer_bulk_retry_interval_seconds,
  ],
  [10, 5, 60]
);

// ——— sweep interval: 0 (back to back) up to 300 s ———
check(
  "interval: the default, 0 (back to back), a fraction and the maximum are kept",
  [10, 0, 2.5, 300].map(configured =>
    effectiveThermometerSweepSetting("thermometer_sweep_interval_seconds", configured)
  ),
  [{ value: 10 }, { value: 0 }, { value: 2.5 }, { value: 300 }]
);
check(
  "interval: above the maximum clamps to it, with the reason",
  effectiveThermometerSweepSetting("thermometer_sweep_interval_seconds", 301),
  { value: 300, correction: "301 s exceeds the 300 s maximum, using the maximum" }
);
check(
  "interval: negative falls back to the default, with the reason",
  effectiveThermometerSweepSetting("thermometer_sweep_interval_seconds", -1),
  { value: 10, correction: "-1 is not a non-negative number of seconds, using the default 10 s" }
);
check(
  "interval: a string, NaN, Infinity, null or a missing key fall back to the default",
  ["10", NaN, Infinity, null, undefined].map(
    configured => effectiveThermometerSweepSetting("thermometer_sweep_interval_seconds", configured).value
  ),
  [10, 10, 10, 10, 10]
);
check(
  "interval: a string is quoted in the correction",
  effectiveThermometerSweepSetting("thermometer_sweep_interval_seconds", "10").correction,
  '"10" is not a non-negative number of seconds, using the default 10 s'
);

// ——— silent probe page: 1 to 60 min ———
check(
  "silent page: the default and both bounds are kept",
  [5, 1, 60].map(configured => effectiveThermometerSweepSetting("thermometer_silent_page_after_minutes", configured)),
  [{ value: 5 }, { value: 1 }, { value: 60 }]
);
check(
  "silent page: below the minimum (0 included) clamps up, with the reason",
  [0, 0.5].map(configured => effectiveThermometerSweepSetting("thermometer_silent_page_after_minutes", configured)),
  [
    { value: 1, correction: "0 min is below the 1 min minimum, using the minimum" },
    { value: 1, correction: "0.5 min is below the 1 min minimum, using the minimum" },
  ]
);
check(
  "silent page: above the maximum clamps down, with the reason",
  effectiveThermometerSweepSetting("thermometer_silent_page_after_minutes", 90),
  { value: 60, correction: "90 min exceeds the 60 min maximum, using the maximum" }
);
check(
  "silent page: negative or not a number falls back to the default 5 min",
  [-5, "5", NaN, undefined].map(configured =>
    effectiveThermometerSweepSetting("thermometer_silent_page_after_minutes", configured)
  ),
  [
    { value: 5, correction: "-5 is not a non-negative number of minutes, using the default 5 min" },
    { value: 5, correction: '"5" is not a non-negative number of minutes, using the default 5 min' },
    { value: 5, correction: "NaN is not a non-negative number of minutes, using the default 5 min" },
    { value: 5, correction: "undefined is not a non-negative number of minutes, using the default 5 min" },
  ]
);

// ——— bulk read retry: 10 s to 1 h ———
check(
  "bulk retry: the default and both bounds are kept",
  [60, 10, 3600].map(configured =>
    effectiveThermometerSweepSetting("thermometer_bulk_retry_interval_seconds", configured)
  ),
  [{ value: 60 }, { value: 10 }, { value: 3600 }]
);
check(
  "bulk retry: below the minimum clamps up, above the maximum down",
  [0, 7200].map(configured => effectiveThermometerSweepSetting("thermometer_bulk_retry_interval_seconds", configured)),
  [
    { value: 10, correction: "0 s is below the 10 s minimum, using the minimum" },
    { value: 3600, correction: "7200 s exceeds the 3600 s maximum, using the maximum" },
  ]
);
check(
  "bulk retry: negative or not a number falls back to the default 60 s",
  [-1, "60", null].map(
    configured => effectiveThermometerSweepSetting("thermometer_bulk_retry_interval_seconds", configured).value
  ),
  [60, 60, 60]
);

// ——— the staleness limit never undercuts three sweep intervals ———
check(
  "stale limit: at 10 s the configured 10 min stands",
  temperatureStaleAfterMs(10 * minuteMs, { thermometer_sweep_interval_seconds: 10 }),
  10 * minuteMs
);
check(
  "stale limit: at 300 s it stretches to three intervals",
  temperatureStaleAfterMs(10 * minuteMs, { thermometer_sweep_interval_seconds: 300 }),
  15 * minuteMs
);
check(
  "stale limit: back to back, a 1 min limit stands",
  temperatureStaleAfterMs(minuteMs, { thermometer_sweep_interval_seconds: 0 }),
  minuteMs
);
check(
  "stale limit: an out-of-range interval counts as its clamped value",
  temperatureStaleAfterMs(minuteMs, { thermometer_sweep_interval_seconds: 1000 }),
  15 * minuteMs
);
check(
  "stale limit: no config yet (the dashboard before it arrives) counts as the default interval",
  temperatureStaleAfterMs(3 * minuteMs, undefined),
  3 * minuteMs
);

// ——— live: corrected values, one warning per bad value, a line per change, the snapshot a sweep runs with ———
{
  const harness = startHarness({
    thermometer_sweep_interval_seconds: 10,
    thermometer_silent_page_after_minutes: 0,
    thermometer_bulk_retry_interval_seconds: "60" as unknown as number,
  });
  check("live: a sweep runs with the corrected values", currentSweepSettings(harness.liveSettings), {
    thermometer_sweep_interval_seconds: 10,
    thermometer_silent_page_after_minutes: 1,
    thermometer_bulk_retry_interval_seconds: 60,
  });
  check("live: each bad value warned once, naming its key", warnings(harness), [
    "temperature_saving.thermometer_silent_page_after_minutes: 0 min is below the 1 min minimum, using the minimum",
    'temperature_saving.thermometer_bulk_retry_interval_seconds: "60" is not a non-negative number of seconds, using the default 60 s',
  ]);

  harness.setConfig(previous => ({ ...previous, mqtt_host: "192.168.0.4" }));
  check("live: an unrelated config write repeats no warning", warnings(harness).length, 2);

  harness.lines.length = 0;
  setSweepSetting(harness, "thermometer_silent_page_after_minutes", 15);
  setSweepSetting(harness, "thermometer_bulk_retry_interval_seconds", 300);
  check(
    "live: each change applies at once and is logged with its key and unit",
    [currentSweepSettings(harness.liveSettings), harness.lines.map(line => line.text)],
    [
      {
        thermometer_sweep_interval_seconds: 10,
        thermometer_silent_page_after_minutes: 15,
        thermometer_bulk_retry_interval_seconds: 300,
      },
      [
        "temperature_saving.thermometer_silent_page_after_minutes: 1 → 15 min, from the next sweep",
        "temperature_saving.thermometer_bulk_retry_interval_seconds: 60 → 300 s, from the next sweep",
      ],
    ]
  );

  harness.lines.length = 0;
  setSweepSetting(harness, "thermometer_bulk_retry_interval_seconds", 5000);
  setSweepSetting(harness, "thermometer_bulk_retry_interval_seconds", 9000);
  check(
    "live: two values that clamp to the same maximum warn once each, but change the value only once",
    [warnings(harness), changeLines(harness)],
    [
      [
        "temperature_saving.thermometer_bulk_retry_interval_seconds: 5000 s exceeds the 3600 s maximum, using the maximum",
        "temperature_saving.thermometer_bulk_retry_interval_seconds: 9000 s exceeds the 3600 s maximum, using the maximum",
      ],
      ["temperature_saving.thermometer_bulk_retry_interval_seconds: 300 → 3600 s, from the next sweep"],
    ]
  );
  harness.stop();
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall thermometer sweep settings checks passed");

function startHarness(initialSettings: ThermometerSweepSettings): SettingsHarness {
  return createRoot(dispose => {
    const [config, setConfig] = createSignal<Config>({
      ...default_config,
      temperature_saving: { ...default_config.temperature_saving, ...initialSettings },
    });
    const lines: LoggedLine[] = [];
    const liveSettings = useThermometerSweepSettings(config, capturingLogger(lines));
    return { liveSettings, lines, setConfig, stop: dispose };
  });
}

function setSweepSetting(
  harness: SettingsHarness,
  settingName: keyof ThermometerSweepSettings,
  configuredValue: number
) {
  harness.setConfig(previous => ({
    ...previous,
    temperature_saving: { ...previous.temperature_saving, [settingName]: configuredValue },
  }));
}

function capturingLogger(lines: LoggedLine[]): SweepLogger {
  return {
    log: (...details) => lines.push({ level: "log", text: details.map(String).join(" ") }),
    warn: (...details) => lines.push({ level: "warn", text: details.map(String).join(" ") }),
    error: (...details) => lines.push({ level: "error", text: details.map(String).join(" ") }),
  };
}

function warnings(harness: SettingsHarness) {
  return harness.lines.filter(line => line.level === "warn").map(line => line.text);
}

function changeLines(harness: SettingsHarness) {
  return harness.lines.filter(line => line.level === "log").map(line => line.text);
}
