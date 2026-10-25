/**
 * Self-test for the refit bookkeeping: pages once per episode, retries back off, and refits only
 * when due. Run from backend/ with:
 *   yarn node src/solar/solarRefit.selftest.ts
 */
import { promises as fs_promises } from "fs";
import os from "os";
import path from "path";
import { unshadedMask } from "./pvModel.ts";
import { isRefitDue } from "./solarRefitScheduler.ts";
import {
  emptyRefitStatus,
  pageOncePerEpisode,
  persistIfUnchanged,
  recordCompletedRefit,
  recordFailure,
} from "./solarRefit.ts";
import type { RefitJudgement } from "./solarRefitGates.ts";
import { loadSolarModelState, saveSolarModelState, useSolarModelStatePathForTests } from "./solarModelStore.ts";
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

  const solarModel = testSolarModel();
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

// ---------- with a fit in place, a failure backs off — it doesn't wait a month ----------
{
  const solarModel = testSolarModel();
  const fit = incumbentState(); // fitted 2026-06-03 01:40 UTC
  const failedAtMs = Date.parse("2026-07-04T01:40:00Z"); // 03:40 local, the fit is 31 days old
  const status = emptyRefitStatus();
  recordFailure(status, {
    nowMs: failedAtMs,
    incumbent: fit,
    refit_every_days: 30,
    error: new Error("open-meteo down"),
  });
  const state: SolarModelState = { version: 2, fit, refit: status };
  const dueAfter = (hours: number) => isRefitDue(state, solarModel, failedAtMs + hours * 3600_000);
  check("fitted back-off: not before the 3 h back-off ends", !dueAfter(1) && !dueAfter(2.9));
  check("fitted back-off: … and not outside the night window (06:40 local)", !dueAfter(3.1));
  check("fitted back-off: retried the next night, not a month later", dueAfter(24), `(next ${status.next_attempt_at})`);

  // Nightly failures from day 31: the "refits keep failing" P2 must fire once the fit is 37+ days old
  const nightly = emptyRefitStatus();
  let pagedAtAgeDays: number | undefined;
  for (let night = 0; night < 15; night++) {
    const attemptMs = failedAtMs + night * 86_400_000;
    const nightState: SolarModelState = { version: 2, fit, refit: nightly };
    if (!isRefitDue(nightState, solarModel, attemptMs)) continue;
    recordFailure(nightly, { nowMs: attemptMs, incumbent: fit, refit_every_days: 30, error: new Error("Influx down") });
    if (nightly.paged.failing && pagedAtAgeDays === undefined) {
      pagedAtAgeDays = (attemptMs - Date.parse(fit.fitted_at)) / 86_400_000;
    }
  }
  check(
    "fitted back-off: the failing P2 fires at the first nightly retry past 37 days",
    pagedAtAgeDays !== undefined && pagedAtAgeDays > 37 && pagedAtAgeDays <= 38,
    `(paged at a fit age of ${pagedAtAgeDays} days)`
  );
}

// ---------- the save only goes through if the file still holds what the refit started from ----------
{
  const startedFrom = "2026-06-03T01:40:00.000Z";
  const newState: SolarModelState = {
    version: 2,
    fit: { ...incumbentState(), fitted_at: "2026-07-04T01:40:00.000Z" },
    refit: emptyRefitStatus(),
  };
  const fakeStore = (current: SolarModelState | undefined, saveError?: Error) => {
    const saved: SolarModelState[] = [];
    return {
      saved,
      store: {
        load: async () => current,
        save: async (state: SolarModelState) => {
          if (saveError) throw saveError;
          saved.push(state);
        },
      },
    };
  };
  const copiedIn = fakeStore({
    version: 2,
    fit: { ...incumbentState(), fitted_at: "2026-06-30T12:00:00.000Z" },
    refit: emptyRefitStatus(),
  });
  check(
    "save guard: a fit copied in while the refit ran is kept",
    (await persistIfUnchanged(newState, startedFrom, copiedIn.store)) === "superseded" && copiedIn.saved.length === 0
  );
  const deleted = fakeStore(undefined);
  check(
    "save guard: a file deleted while the refit ran stays deleted",
    (await persistIfUnchanged(newState, startedFrom, deleted.store)) === "superseded" && deleted.saved.length === 0
  );
  const unchanged = fakeStore({ version: 2, fit: incumbentState(), refit: emptyRefitStatus() });
  check(
    "save guard: an unchanged file is updated",
    (await persistIfUnchanged(newState, startedFrom, unchanged.store)) === "saved" && unchanged.saved.length === 1
  );
  const firstBoot = fakeStore(undefined);
  check(
    "save guard: with no file before and after (first fit), the save goes through",
    (await persistIfUnchanged(newState, undefined, firstBoot.store)) === "saved"
  );

  const errorLines: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => errorLines.push(args.map(String).join(" "));
  const diskFull = fakeStore({ version: 2, fit: incumbentState(), refit: emptyRefitStatus() }, new Error("ENOSPC"));
  const firstFailure = await persistIfUnchanged(newState, startedFrom, diskFull.store);
  const secondFailure = await persistIfUnchanged(newState, startedFrom, diskFull.store);
  console.error = originalConsoleError;
  check(
    "save failure: reported, paged once per episode",
    firstFailure === "failed" &&
      secondFailure === "failed" &&
      errorLines.filter(line => line.includes("[ERROR]")).length === 1,
    `(${errorLines.length} error lines)`
  );
}

// ---------- a failed write keeps the new state in memory until the file changes ----------
{
  const directory = await fs_promises.mkdtemp(path.join(os.tmpdir(), "solar-store-selftest-"));
  const statePath = path.join(directory, "solar_model_state.json");
  useSolarModelStatePathForTests(statePath);
  const state: SolarModelState = { version: 2, fit: incumbentState(), refit: emptyRefitStatus() };
  await fs_promises.chmod(directory, 0o555); // read-only directory: the temp-file write fails
  let saveThrew = false;
  try {
    await saveSolarModelState(state);
  } catch {
    saveThrew = true; // expected: that's the failure under test
  }
  const inMemory = await loadSolarModelState();
  check("store: a failed write throws for the caller to report", saveThrew);
  check(
    "store: … and the state lives on in memory (file missing branch)",
    inMemory?.fit?.fitted_at === state.fit?.fitted_at
  );
  await fs_promises.chmod(directory, 0o755);
  await saveSolarModelState({ ...state, refit: { ...state.refit, last_outcome: "accepted" } });
  const persisted = JSON.parse(await fs_promises.readFile(statePath, { encoding: "utf-8" })) as SolarModelState;
  check("store: a later successful write persists and takes over", persisted.refit.last_outcome === "accepted");
  await fs_promises.rm(statePath);
  check("store: deleting the file is noticed without a restart", (await loadSolarModelState()) === undefined);
  await fs_promises.rm(directory, { recursive: true, force: true });
}

// ---------- alternating unreachable / low-coverage nights page once per kind ----------
{
  const solarModel = testSolarModel();
  const fit = incumbentState(); // fitted 2026-06-03; by 2026-07-12 it is 39 days old: overdue
  const status = emptyRefitStatus();
  const lowCoverage: RefitJudgement = {
    accepted: false,
    hardFailure: true,
    pages: { hard_failure: ["only 40 % of the last 60 days have complete inverter telemetry"] },
    warnReasons: [],
    levels: {
      string1: { multiplier: 1, ratios: [] },
      string2: { multiplier: 1, ratios: [] },
    },
    consecutiveRejections: 0,
  };
  const errorLines: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => errorLines.push(args.map(String).join(" "));
  const firstNightMs = Date.parse("2026-07-12T01:40:00Z");
  for (let night = 0; night < 6; night++) {
    const nowMs = firstNightMs + night * 86_400_000;
    if (!isRefitDue({ version: 2, fit, refit: status }, solarModel, nowMs)) continue;
    if (night % 2 === 0) {
      recordFailure(status, { nowMs, incumbent: fit, refit_every_days: 30, error: new Error("connect ECONNREFUSED") });
    } else {
      recordCompletedRefit(status, lowCoverage, { incumbent: fit, nowMs });
    }
  }
  console.error = originalConsoleError;
  const failingPages = errorLines.filter(line => line.includes("refits keep failing")).length;
  const coveragePages = errorLines.filter(line => line.includes("complete inverter telemetry")).length;
  check(
    "paging: alternating unreachable and low-coverage nights page once per kind",
    failingPages === 1 && coveragePages === 1,
    `(failing ${failingPages}, coverage ${coveragePages})`
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

function testSolarModel() {
  return {
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
}
