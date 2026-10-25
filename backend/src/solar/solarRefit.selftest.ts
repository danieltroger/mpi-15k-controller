/**
 * Self-test for the refit bookkeeping: pages once per episode, retries back off, and refits only
 * when due. Run from backend/ with:
 *   yarn node src/solar/solarRefit.selftest.ts
 */
import { unshadedMask } from "./pvModel.ts";
import { isRefitDue } from "./solarRefitScheduler.ts";
import { emptyRefitStatus, pageOncePerEpisode, recordFailure } from "./solarRefit.ts";
import type { SolarModelFit, SolarModelState } from "./solarModel.types.ts";

const fails: string[] = [];
function check(name: string, condition: boolean, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}: ${name} ${detail}`);
  if (!condition) fails.push(name);
}

// ---------- paging once per episode, back-off, due-ness ----------
{
  const status = emptyRefitStatus();
  const nowMs = Date.parse("2026-07-03T01:40:00Z");
  pageOncePerEpisode(status, { hard_failure: ["capacity off"] }, nowMs);
  const firstPagedAt = status.paged.hard_failure;
  pageOncePerEpisode(status, { hard_failure: ["capacity off"] }, nowMs + 3 * 3600_000);
  check("paging: a hard failure pages once per episode", !!firstPagedAt && status.paged.hard_failure === firstPagedAt);
  pageOncePerEpisode(status, {}, nowMs + 6 * 3600_000);
  check("paging: a clean refit re-arms the page", status.paged.hard_failure === undefined);

  const failing = emptyRefitStatus();
  const error = new Error("open-meteo down");
  const delays: number[] = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    const attemptMs = nowMs + attempt * 86_400_000;
    recordFailure(failing, { nowMs: attemptMs, incumbent: undefined, refit_every_days: 30, error });
    delays.push((Date.parse(failing.next_attempt_at ?? "") - attemptMs) / 3600_000);
  }
  check("back-off: 3 h → 12 h → daily", delays.join(",") === "3,12,24,24", `(${delays.join(",")} h)`);
  check("back-off: with no fit, failing for a day pages exactly once", failing.paged.failing !== undefined);

  const solarModel = {
    string1: {
      tilt_degrees: 36,
      azimuth_degrees: 180,
      nameplate_kwp: 11.25,
      max_current_amps: 23,
      typical_mpp_volts: 460,
    },
    string2: {
      tilt_degrees: 45,
      azimuth_degrees: 300,
      nameplate_kwp: 6.16,
      max_current_amps: 23,
      typical_mpp_volts: 580,
    },
    rewired_at: "",
    history_start: "2024-04-01",
    refit_every_days: 30,
    mask_half_life_days: 365,
    mask_irradiance_source: "satellite" as const,
    snow_nowcast: true,
  };
  const fitted: SolarModelState = { version: 2, fit: incumbentState(), refit: emptyRefitStatus() };
  check("due: no state at all → fit now", isRefitDue(undefined, solarModel, nowMs));
  check(
    "due: a back-off blocks even an unfitted retry",
    !isRefitDue(
      { version: 2, refit: { ...emptyRefitStatus(), next_attempt_at: new Date(nowMs + 3600_000).toISOString() } },
      solarModel,
      nowMs
    )
  );
  check("due: a fresh fit is not due", !isRefitDue(fitted, solarModel, Date.parse("2026-06-20T01:40:00Z")));
  check("due: a month-old fit is due at night", isRefitDue(fitted, solarModel, Date.parse("2026-07-04T01:40:00Z")));
  check("due: … but not in the afternoon", !isRefitDue(fitted, solarModel, Date.parse("2026-07-04T11:40:00Z")));
  check(
    "due: an edited geometry refits now",
    isRefitDue(
      fitted,
      { ...solarModel, string2: { ...solarModel.string2, azimuth_degrees: 290 } },
      Date.parse("2026-06-20T11:40:00Z")
    )
  );
}

console.log(fails.length ? `\n${fails.length} FAILURES: ${fails.join(", ")}` : "\nAll refit bookkeeping checks passed");
process.exit(fails.length ? 1 : 0);

function incumbentState(): SolarModelFit {
  const stringFit = {
    physical_k: 8.9,
    physical_sky_factor: 0.9,
    forecast_k: 8.1,
    forecast_sky_factor: 1.4,
    mask: unshadedMask(),
    mask_sample_counts: [],
    level_multiplier: 1,
    level_ratios: [],
  };
  return {
    fitted_at: "2026-06-03T01:40:00.000Z",
    mask_irradiance_source: "satellite",
    geometry: {
      string1: { tilt_degrees: 36, azimuth_degrees: 180 },
      string2: { tilt_degrees: 45, azimuth_degrees: 300 },
    },
    strings: { string1: stringFit, string2: { ...stringFit, physical_k: 5.6, forecast_k: 5.1 } },
    fit_hours: { string1: 10000, string2: 9000 },
    trailing_year_daily_mae_kwh: 4,
  };
}
