/**
 * The live config.json predates the physical solar model: its solar_model holds only the deleted
 * linear model's keys. Loading it must yield every new knob from the defaults and pass the dead
 * keys through untouched. It also predates the overheat sell stop's limits, and still carries the
 * retired alerting.inverter_temp_p1_celsius those replaced, and the thermometer sweep interval, and the
 * setter write throttle (it still carries the retired usb_parameter_setting.min_seconds_between_commands
 * and quiet_gap_after_write_ms, #52). Run from backend/ with:
 *   yarn node src/config/configMerge.selftest.ts
 */
import { default_config, mergeWithDefaults } from "./config.ts";
import { applyConfigPatch } from "./configPatch.ts";
import type { AlertingConfig, Config } from "./config.types.ts";

/** What config.json files written before #56 still carry under alerting */
type RetiredInverterTempKey = { inverter_temp_p1_celsius: unknown };

const fails: string[] = [];
function check(name: string, condition: boolean, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}: ${name} ${detail}`);
  if (!condition) fails.push(name);
}

const legacySolarModel = {
  watts_per_direct_radiation: 10.3,
  watts_per_diffuse_radiation: 17.42,
  refit_interval_days: 14,
  last_fitted_at: "2026-10-05T11:10:51.559Z",
  fit_r2: 0.623,
  fit_samples: 609,
};
const liveLike = {
  automatic_trading: { ...default_config.automatic_trading, enabled: true, solar_model: legacySolarModel },
  alerting: { enabled: true },
} as unknown as Partial<Config>;
const merged = mergeWithDefaults(liveLike);
const solarModel = merged.automatic_trading.solar_model;
check(
  "merge: string specs come from the defaults",
  solarModel.string1.tilt_degrees === 36 && solarModel.string2.azimuth_degrees === 300
);
check(
  "merge: new knobs come from the defaults",
  solarModel.refit_every_days === 30 && solarModel.snow_nowcast === true
);
check(
  "merge: dead linear-model keys pass through untouched",
  (solarModel as unknown as Record<string, unknown>).watts_per_direct_radiation === 10.3
);
check("merge: the new accuracy alert knobs default on", merged.alerting.solar_forecast_accuracy_p2 === true);

const partialString = mergeWithDefaults({
  automatic_trading: {
    ...default_config.automatic_trading,
    solar_model: { ...default_config.automatic_trading.solar_model, string2: { tilt_degrees: 40 } },
  },
} as unknown as Partial<Config>);
check(
  "merge: a partial string spec keeps its other defaults",
  partialString.automatic_trading.solar_model.string2.tilt_degrees === 40 &&
    partialString.automatic_trading.solar_model.string2.nameplate_kwp === 6.16
);

// ——— scheduled_power_selling stored before the overheat stop's inverter-temperature limits ———
const { only_sell_below_inverter_temp_celsius, start_selling_again_below_inverter_temp_celsius, ...olderSelling } =
  default_config.scheduled_power_selling;
// The cast is the point: this is the shape config.json files on disk still have
const sellingBeforeTheLimits = { ...olderSelling, schedule: {} } as Config["scheduled_power_selling"];
const healedSelling = mergeWithDefaults({
  ...structuredClone(default_config),
  scheduled_power_selling: sellingBeforeTheLimits,
}).scheduled_power_selling;
check(
  "merge: an older scheduled_power_selling picks up the temperature limits (else the stop never fires)",
  healedSelling.only_sell_below_inverter_temp_celsius === only_sell_below_inverter_temp_celsius &&
    healedSelling.start_selling_again_below_inverter_temp_celsius === start_selling_again_below_inverter_temp_celsius
);
check(
  "merge: a stored empty schedule doesn't resurrect the default's sample sell window",
  Object.keys(healedSelling.schedule).length === 0
);

// ——— the retired alerting.inverter_temp_p1_celsius: seeds the stop limit once, then is gone ———
const tunedAlerting: AlertingConfig & RetiredInverterTempKey = {
  ...default_config.alerting,
  inverter_temp_p1_celsius: 95,
};
const migrated = mergeWithDefaults({
  ...structuredClone(default_config),
  alerting: tunedAlerting,
  scheduled_power_selling: sellingBeforeTheLimits,
});
check(
  "retired key: a site that tuned the old P1 threshold keeps it as the stop limit",
  migrated.scheduled_power_selling.only_sell_below_inverter_temp_celsius === 95
);
check("retired key: dropped, so the config page can't show it", !("inverter_temp_p1_celsius" in migrated.alerting));
const rewritten = mergeWithDefaults(JSON.parse(JSON.stringify(migrated)));
check(
  "retired key: stays gone after the config-write round trip, and the seeded limit sticks",
  !("inverter_temp_p1_celsius" in rewritten.alerting) &&
    rewritten.scheduled_power_selling.only_sell_below_inverter_temp_celsius === 95
);
const alreadyMigrated = mergeWithDefaults({
  ...structuredClone(default_config),
  alerting: tunedAlerting,
  scheduled_power_selling: { ...default_config.scheduled_power_selling, only_sell_below_inverter_temp_celsius: 96 },
});
check(
  "retired key: an existing stop limit wins over it",
  alreadyMigrated.scheduled_power_selling.only_sell_below_inverter_temp_celsius === 96 &&
    !("inverter_temp_p1_celsius" in alreadyMigrated.alerting)
);
const garbledAlerting: AlertingConfig & RetiredInverterTempKey = {
  ...default_config.alerting,
  inverter_temp_p1_celsius: "97",
};
const garbled = mergeWithDefaults({
  ...structuredClone(default_config),
  alerting: garbledAlerting,
  scheduled_power_selling: sellingBeforeTheLimits,
});
check(
  "retired key: a non-number value is dropped, not seeded",
  garbled.scheduled_power_selling.only_sell_below_inverter_temp_celsius === only_sell_below_inverter_temp_celsius &&
    !("inverter_temp_p1_celsius" in garbled.alerting)
);
// A browser tab opened before the deploy still renders the old field; saving it must not bring it back
const stalePagePatch = applyConfigPatch(migrated, {
  path: ["alerting", "inverter_temp_p1_celsius"],
  op: "set",
  value: 80,
});
const afterStalePatch = "patched" in stalePagePatch ? mergeWithDefaults(stalePagePatch.patched) : migrated;
check(
  "retired key: a stale config page writing it neither resurfaces it nor moves the stop limit",
  !("inverter_temp_p1_celsius" in afterStalePatch.alerting) &&
    afterStalePatch.scheduled_power_selling.only_sell_below_inverter_temp_celsius === 95,
  "patched" in stalePagePatch ? "(patch accepted, merge dropped it)" : `(patch refused: ${stalePagePatch.error})`
);

// ——— temperature_saving stored before the thermometer sweep settings existed (the live pi's, 2026-10-26) ———
const liveTemperatureSaving = { database: "mppsolar", table: "battery_temperatures" };
const withLiveTemperatureSaving = mergeWithDefaults({
  ...structuredClone(default_config),
  // The cast is the point: this is the shape config.json files on disk still have
  temperature_saving: liveTemperatureSaving as Config["temperature_saving"],
});
check(
  "merge: an older temperature_saving picks up the sweep settings' defaults and keeps its database and table",
  JSON.stringify(withLiveTemperatureSaving.temperature_saving) ===
    JSON.stringify({
      ...liveTemperatureSaving,
      thermometer_sweep_interval_seconds: 10,
      thermometer_silent_page_after_minutes: 5,
      thermometer_bulk_retry_interval_seconds: 60,
    })
);
const tunedSweepInterval = mergeWithDefaults({
  ...structuredClone(default_config),
  temperature_saving: { ...default_config.temperature_saving, thermometer_sweep_interval_seconds: 0 },
});
check(
  "merge: a stored sweep interval, even 0 (back to back), wins over the default",
  tunedSweepInterval.temperature_saving.thermometer_sweep_interval_seconds === 0
);
const sweepSettingPatches: [keyof Config["temperature_saving"], number][] = [
  ["thermometer_sweep_interval_seconds", 30],
  ["thermometer_silent_page_after_minutes", 15],
  ["thermometer_bulk_retry_interval_seconds", 300],
];
for (const [settingName, patchedValue] of sweepSettingPatches) {
  const settingPatch = applyConfigPatch(withLiveTemperatureSaving, {
    path: ["temperature_saving", settingName],
    op: "set",
    value: patchedValue,
  });
  check(
    `patch: the config page can set ${settingName} on a merged live config`,
    "patched" in settingPatch &&
      mergeWithDefaults(settingPatch.patched).temperature_saving[settingName] === patchedValue,
    "error" in settingPatch ? settingPatch.error : ""
  );
  const stringPatch = applyConfigPatch(withLiveTemperatureSaving, {
    path: ["temperature_saving", settingName],
    op: "set",
    value: String(patchedValue),
  });
  check(`patch: a string ${settingName} is refused (type preservation)`, "error" in stringPatch);
}

// ——— usb_parameter_setting stored before the write throttle (the live pi's, 2026-10-27) ———
const liveUsbParameterSetting = {
  min_seconds_between_commands: 40,
  poll_values_interval_seconds: 180,
  quiet_gap_after_write_ms: 12000,
};
const withLiveUsbParameterSetting = mergeWithDefaults({
  ...structuredClone(default_config),
  // The cast is the point: this is the shape config.json files on disk still have
  usb_parameter_setting: liveUsbParameterSetting as unknown as Config["usb_parameter_setting"],
});
check(
  "merge: an older usb_parameter_setting picks up the throttle defaults, keeps its poll interval, drops the retired spacing and quiet gap",
  JSON.stringify(withLiveUsbParameterSetting.usb_parameter_setting) ===
    JSON.stringify({
      min_seconds_between_setting_changes: 45,
      ac_charging_current_immediate_decrease_amps: 10,
      poll_values_interval_seconds: 180,
    }),
  JSON.stringify(withLiveUsbParameterSetting.usb_parameter_setting)
);
check(
  "retired keys: the defaults carry neither",
  !("min_seconds_between_commands" in default_config.usb_parameter_setting) &&
    !("quiet_gap_after_write_ms" in default_config.usb_parameter_setting)
);
const shortInterval = mergeWithDefaults({
  ...structuredClone(default_config),
  usb_parameter_setting: { ...default_config.usb_parameter_setting, min_seconds_between_setting_changes: 20 },
});
check(
  "merge: a stored interval (20 s) wins over the default",
  shortInterval.usb_parameter_setting.min_seconds_between_setting_changes === 20
);
const throttleSettingPatches: [keyof Config["usb_parameter_setting"], number][] = [
  ["min_seconds_between_setting_changes", 90],
  ["ac_charging_current_immediate_decrease_amps", 5],
];
for (const [settingName, patchedValue] of throttleSettingPatches) {
  const settingPatch = applyConfigPatch(withLiveUsbParameterSetting, {
    path: ["usb_parameter_setting", settingName],
    op: "set",
    value: patchedValue,
  });
  check(
    `patch: the config page can set ${settingName} on a merged live config`,
    "patched" in settingPatch &&
      mergeWithDefaults(settingPatch.patched).usb_parameter_setting[settingName] === patchedValue,
    "error" in settingPatch ? settingPatch.error : ""
  );
}
// A config page opened before the deploy still renders these fields; saving one must not bring it back
for (const [retiredKey, staleValue] of [
  ["min_seconds_between_commands", 40],
  ["quiet_gap_after_write_ms", 0],
] as const) {
  const stalePatch = applyConfigPatch(withLiveUsbParameterSetting, {
    path: ["usb_parameter_setting", retiredKey],
    op: "set",
    value: staleValue,
  });
  check(
    `retired key: a stale config page writing ${retiredKey} doesn't bring it back`,
    !("patched" in stalePatch && retiredKey in mergeWithDefaults(stalePatch.patched).usb_parameter_setting),
    "patched" in stalePatch ? "(patch accepted, merge dropped it)" : `(patch refused: ${stalePatch.error})`
  );
}

console.log(fails.length ? `\n${fails.length} FAILURES: ${fails.join(", ")}` : "\nAll config merge checks passed");
process.exit(fails.length ? 1 : 0);
