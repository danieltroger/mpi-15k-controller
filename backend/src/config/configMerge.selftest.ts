/**
 * The live config.json predates the physical solar model: its solar_model holds only the deleted
 * linear model's keys. Loading it must yield every new knob from the defaults and pass the dead
 * keys through untouched. Run from backend/ with:
 *   yarn node src/config/configMerge.selftest.ts
 */
import { default_config, mergeWithDefaults } from "./config.ts";
import type { Config } from "./config.types.ts";

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

console.log(fails.length ? `\n${fails.length} FAILURES: ${fails.join(", ")}` : "\nAll config merge checks passed");
process.exit(fails.length ? 1 : 0);
