/**
 * Pure self-test of the grid-off switch: the DM whitelist and its wire format, the DM decode and response
 * shape, the setter's readback confirm, the switch-on preconditions, the guards, the startup fail-safe and
 * the grid_off knobs. No hardware. Run from backend/ with:
 *   yarn node src/gridOff/gridOff.selftest.ts
 */
import process from "process";
import { buildQueryFrame, buildSetterFrame, classifyFrame } from "../inverterComms/pi17Frames.ts";
import { decodeQueryPayload } from "../inverterComms/pi17Decode.ts";
import { frameMismatchForExpectation } from "../inverterComms/pi17ResponseShapes.ts";
import { implausibleFieldsIn } from "../inverterComms/plausibilityGate.ts";
import { dataFrameAsTheInverterSendsIt } from "../inverterComms/pi17StatusFixtures.ts";
import { checkIsSatisfied, expectedReadbackChecksForSetter } from "../inverterComms/setterConfirmation.ts";
import {
  initialSchedulerState,
  readbackAlreadySatisfies,
  withSettingsReadback,
} from "../inverterComms/schedulerCore.ts";
import {
  isWhitelistedMachineModel,
  machineModelSetterCommand,
  machineModelSetterRefusal,
} from "../inverterComms/machineModel.ts";
import { default_config, mergeWithDefaults } from "../config/config.ts";
import type { Config, GridOffConfig } from "../config/config.types.ts";
import { DEFAULT_GRID_OFF_SETTINGS, effectiveGridOffSettings } from "./gridOffSettings.ts";
import {
  FRESH_INVERTER_READING_MAX_AGE_MS,
  type GridOffSituation,
  machineModelReadbackMaxAgeMs,
  NO_SWITCH_BACK_SENDS,
  NOT_STUCK_OFF_GRID,
  reconcileMachineModel,
  revertReason,
  SWITCH_CONFIRM_DEADLINE_MS,
  switchBackResendDue,
  switchOffGridRefusal,
  trackStuckOffGrid,
} from "./gridOffDecisions.ts";
import {
  afterMachineModelQuery,
  INITIAL_MACHINE_MODEL_POLL_STATE,
  MACHINE_MODEL_POLL_BACKOFF_MS,
  machineModelPollDue,
} from "../inverterComms/machineModelPolling.ts";

const fails: string[] = [];
function check(name: string, condition: boolean, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}: ${name} ${detail}`);
  if (!condition) fails.push(name);
}

// ---------- the whitelist and the wire format (spec: ^P003DM, ^S006DMnnn, ^D006AAA) ----------
check("the DM query goes out as ^P003DM\\r", buildQueryFrame("DM").toString("latin1") === "^P003DM\r");
check(
  "DM151 goes out as ^S006DM151\\r",
  buildSetterFrame(machineModelSetterCommand("151")).toString("latin1") === "^S006DM151\r"
);
check(
  "DM050 goes out as ^S006DM050\\r",
  buildSetterFrame(machineModelSetterCommand("050")).toString("latin1") === "^S006DM050\r"
);
check(
  "DM050 and DM151 pass the session's gate",
  !machineModelSetterRefusal("DM050") && !machineModelSetterRefusal("DM151")
);
for (const refused of [
  "DM150",
  "DM061",
  "DM100",
  "DM05",
  "DM0500",
  "DM",
  "DMabc",
  "DM 151",
  "dm151",
  "Dm050",
  " DM151",
  "DM151 ",
  "XDM151",
  "DM151\r",
]) {
  check(`${JSON.stringify(refused)} is refused`, machineModelSetterRefusal(refused) !== undefined);
}
check("a non-string command is refused", machineModelSetterRefusal(151) !== undefined);
check("non-DM setters are none of the whitelist's business", machineModelSetterRefusal("GPMP000350") === undefined);
check(
  "only 050 and 151 are whitelisted",
  isWhitelistedMachineModel("050") &&
    isWhitelistedMachineModel("151") &&
    !isWhitelistedMachineModel("150") &&
    !isWhitelistedMachineModel("50") &&
    !isWhitelistedMachineModel(undefined)
);

// ---------- decode and attribution ----------
for (const model of ["050", "151"]) {
  const frame = classifyFrame(dataFrameAsTheInverterSendsIt(model));
  check(`^D006${model} classifies as a data frame`, frame.kind === "data");
  if (frame.kind !== "data") continue;
  const { fields, problems } = decodeQueryPayload("DM", frame.payloadText);
  check(
    `DM ${model} decodes to machine_model "${model}" (a string, leading zero kept)`,
    fields.machine_model === model
  );
  check(`DM ${model} decodes without problems`, problems.length === 0, problems.join("; "));
  check(`DM ${model} passes the plausibility gate`, implausibleFieldsIn(fields).length === 0);
  check(
    `DM ${model} fits a DM in flight`,
    frameMismatchForExpectation({ kind: "query", command: "DM" }, frame) === undefined
  );
  for (const otherCommand of ["MOD", "GPMP", "CFS"] as const) {
    check(
      `DM ${model} is rejected while ${otherCommand} is in flight`,
      frameMismatchForExpectation({ kind: "query", command: otherCommand }, frame) !== undefined
    );
  }
}
for (const [otherCommand, payload] of [
  ["MOD", "05"],
  ["GPMP", "15000"],
] as const) {
  const frame = classifyFrame(dataFrameAsTheInverterSendsIt(payload));
  check(
    `a late ${otherCommand} answer (${payload}) is rejected while DM is in flight`,
    frame.kind === "data" && frameMismatchForExpectation({ kind: "query", command: "DM" }, frame) !== undefined
  );
}
check(
  "an ACK can't answer a DM query",
  frameMismatchForExpectation({ kind: "query", command: "DM" }, { kind: "ack" }) !== undefined
);

// ---------- readback confirm and the satisfied drop ----------
const dm151Checks = expectedReadbackChecksForSetter("DM151");
check(
  "DM151 is confirmed by DM machine_model reading 151",
  dm151Checks.length === 1 &&
    dm151Checks[0]!.query === "DM" &&
    dm151Checks[0]!.field === "machine_model" &&
    dm151Checks[0]!.expectedValue === "151"
);
check("a 151 readback satisfies DM151", checkIsSatisfied(dm151Checks[0]!, { DM: { machine_model: "151" } }));
check("a 050 readback doesn't satisfy DM151", !checkIsSatisfied(dm151Checks[0]!, { DM: { machine_model: "050" } }));
{
  const scheduler = withSettingsReadback(initialSchedulerState(), "DM", { machine_model: "050" }, 1_000);
  check("DM050 is dropped unsent while the inverter reads 050 (inert)", readbackAlreadySatisfies(scheduler, "DM050"));
  check("DM151 is not dropped while the inverter reads 050", !readbackAlreadySatisfies(scheduler, "DM151"));
}

// ---------- the switch-on preconditions ----------
const NOW_MS = Date.parse("2026-11-03T22:00:00Z");
const settings: GridOffConfig = DEFAULT_GRID_OFF_SETTINGS;
const quietNight: GridOffSituation = {
  nowMs: NOW_MS,
  soc: 60,
  inverterReadingAgeMs: 1_200,
  readbackModel: "050",
  readbackAgeMs: 30_000,
  readbackMaxAgeMs: machineModelReadbackMaxAgeMs(300),
  lastSwitchAtMs: undefined,
  sellSchedule: { "2026-11-03T16:00:00Z": { end_time: "2026-11-03T17:00:00Z" } },
  buySchedule: { "2026-11-04T03:00:00Z": { end_time: "2026-11-04T04:00:00Z" } },
};
const windowAt = (startOffsetMinutes: number, lengthMinutes = 60) => ({
  [new Date(NOW_MS + startOffsetMinutes * 60_000).toISOString()]: {
    end_time: new Date(NOW_MS + (startOffsetMinutes + lengthMinutes) * 60_000).toISOString(),
  },
});
check("a quiet night with 60 % may switch", switchOffGridRefusal(quietNight, settings) === undefined);
check(
  "refused with grid_off.poll_machine_model off",
  switchOffGridRefusal(quietNight, { ...settings, poll_machine_model: false })?.includes("poll_machine_model") === true
);
check(
  "refused on a DM readback older than two settings rounds and a minute (11 min at 300 s)",
  switchOffGridRefusal({ ...quietNight, readbackAgeMs: 11 * 60_000 + 1 }, settings)?.includes("min old") === true &&
    switchOffGridRefusal({ ...quietNight, readbackAgeMs: 11 * 60_000 }, settings) === undefined
);
check(
  "refused 59 s after the last switch (min_seconds_between_switches 60)",
  switchOffGridRefusal({ ...quietNight, lastSwitchAtMs: NOW_MS - 59_000 }, settings)?.includes(
    "min_seconds_between_switches"
  ) === true
);
check(
  "allowed 60 s after the last switch",
  switchOffGridRefusal({ ...quietNight, lastSwitchAtMs: NOW_MS - 60_000 }, settings) === undefined
);
check(
  "refused before the first DM readback",
  switchOffGridRefusal({ ...quietNight, readbackModel: undefined }, settings) !== undefined
);
check(
  "refused while the inverter reads 151",
  switchOffGridRefusal({ ...quietNight, readbackModel: "151" }, settings) !== undefined
);
check(
  "refused from a model it never writes (150)",
  switchOffGridRefusal({ ...quietNight, readbackModel: "150" }, settings)?.includes("150") === true
);
check(
  "refused on stale readings",
  switchOffGridRefusal({ ...quietNight, inverterReadingAgeMs: FRESH_INVERTER_READING_MAX_AGE_MS + 1 }, settings) !==
    undefined
);
check(
  "refused without readings",
  switchOffGridRefusal({ ...quietNight, inverterReadingAgeMs: undefined }, settings) !== undefined
);
check("refused with the SOC unknown", switchOffGridRefusal({ ...quietNight, soc: undefined }, settings) !== undefined);
check(
  "refused just below the floor plus margin (14.9 % < 10 + 5)",
  switchOffGridRefusal({ ...quietNight, soc: 14.9 }, settings)?.includes("15 %") === true
);
check(
  "allowed at exactly the floor plus margin (15 %)",
  switchOffGridRefusal({ ...quietNight, soc: 15 }, settings) === undefined
);
check(
  "refused while a sell window is active",
  switchOffGridRefusal({ ...quietNight, sellSchedule: windowAt(-5) }, settings)?.includes("sell window is active") ===
    true
);
check(
  "refused 9 min before a buy window (lead 10 min)",
  switchOffGridRefusal({ ...quietNight, buySchedule: windowAt(9) }, settings)?.includes(
    "buy window starts in 9 min"
  ) === true
);
check(
  "allowed 11 min before a buy window",
  switchOffGridRefusal({ ...quietNight, buySchedule: windowAt(11) }, settings) === undefined
);
check(
  "a hold (any power) counts as a buy window",
  switchOffGridRefusal({ ...quietNight, buySchedule: windowAt(0, 120) }, settings) !== undefined
);
check(
  "an entry whose times don't parse is skipped",
  switchOffGridRefusal({ ...quietNight, sellSchedule: { "not a date": { end_time: "never" } } }, settings) === undefined
);
check(
  "the lead follows the knob (30 min)",
  switchOffGridRefusal(
    { ...quietNight, buySchedule: windowAt(25) },
    { ...settings, reconnect_before_window_minutes: 30 }
  ) !== undefined
);

// ---------- the guards while 151 is requested ----------
const requestedAtMs = NOW_MS - 20 * 60_000;
const offGridNight: GridOffSituation = { ...quietNight, readbackModel: "151" };
check("off the grid on a quiet night: stay", revertReason(offGridNight, settings, requestedAtMs) === undefined);
check(
  "(a) SOC below grid_off.min_soc_percent: switch back",
  revertReason({ ...offGridNight, soc: 9.9 }, settings, requestedAtMs)?.includes("min_soc_percent") === true
);
check(
  "(a) SOC exactly at the floor: stay",
  revertReason({ ...offGridNight, soc: 10 }, settings, requestedAtMs) === undefined
);
check(
  "(a) SOC unknown: switch back",
  revertReason({ ...offGridNight, soc: undefined }, settings, requestedAtMs) !== undefined
);
check(
  "(b) a buy window 10 min away: switch back",
  revertReason({ ...offGridNight, buySchedule: windowAt(10) }, settings, requestedAtMs)?.includes("buy window") === true
);
check(
  "(b) a sell window 10.5 min away: stay (the guard tick catches it within 10 s of the lead)",
  revertReason({ ...offGridNight, sellSchedule: windowAt(10.5) }, settings, requestedAtMs) === undefined
);
check(
  "(b) a window added that is already running: switch back",
  revertReason({ ...offGridNight, sellSchedule: windowAt(-1) }, settings, requestedAtMs) !== undefined
);
check(
  "stale readings while off the grid: switch back",
  revertReason({ ...offGridNight, inverterReadingAgeMs: 90_000 }, settings, requestedAtMs) !== undefined
);
check(
  "151 not read back yet 30 s after the request: keep waiting",
  revertReason({ ...offGridNight, readbackModel: "050" }, settings, NOW_MS - 30_000) === undefined
);
check(
  "151 still not read back past the confirm deadline: give up",
  revertReason({ ...offGridNight, readbackModel: "050" }, settings, NOW_MS - SWITCH_CONFIRM_DEADLINE_MS - 1)?.includes(
    "after 151 was requested"
  ) === true
);
check(
  "the inverter leaving 151 by itself later: switch back",
  revertReason({ ...offGridNight, readbackModel: "050" }, settings, requestedAtMs) !== undefined
);

// ---------- the startup fail-safe and the readback reconciliation ----------
const startup = reconcileMachineModel({ requestedModel: "050", readbackModel: "151", firstReadbackSinceStart: true });
check(
  "startup reading 151: switch back, said as the startup fail-safe",
  startup.action === "switch_back" && startup.reason.includes("startup fail-safe")
);
const later = reconcileMachineModel({ requestedModel: "050", readbackModel: "151", firstReadbackSinceStart: false });
check(
  "151 read later while 050 is wanted: switch back too",
  later.action === "switch_back" && !later.reason.includes("startup")
);
check(
  "startup reading 050: nothing to do (inert)",
  reconcileMachineModel({ requestedModel: "050", readbackModel: "050", firstReadbackSinceStart: true }).action ===
    "none"
);
check(
  "151 requested, still reading 050: the request's own deadline handles it",
  reconcileMachineModel({ requestedModel: "151", readbackModel: "050", firstReadbackSinceStart: false }).action ===
    "none"
);
check(
  "a model the switch never writes is left alone",
  reconcileMachineModel({ requestedModel: "050", readbackModel: "150", firstReadbackSinceStart: true }).action ===
    "leave_alone"
);
check(
  "no readback yet: nothing to do",
  reconcileMachineModel({ requestedModel: "050", readbackModel: undefined, firstReadbackSinceStart: false }).action ===
    "none"
);

// ---------- stuck on 151 while 050 is wanted ----------
{
  const stuckInputs = { requestedModel: "050" as const, readbackModel: "151", nowMs: NOW_MS };
  const started = trackStuckOffGrid(NOT_STUCK_OFF_GRID, stuckInputs, settings);
  check(
    "050 wanted, 151 read: the condition starts, not stuck yet",
    started.conditionSinceMs === NOW_MS && !started.stuck
  );
  const twoMinutes = trackStuckOffGrid(started, { ...stuckInputs, nowMs: NOW_MS + 2 * 60_000 }, settings);
  check("…2 min in: not stuck", !twoMinutes.stuck && twoMinutes.conditionSinceMs === NOW_MS);
  const threeMinutes = trackStuckOffGrid(twoMinutes, { ...stuckInputs, nowMs: NOW_MS + 3 * 60_000 }, settings);
  check("…3 min in (stuck_p1_after_minutes): stuck", threeMinutes.stuck);
  check(
    "…reading 050 again ends it",
    trackStuckOffGrid(threeMinutes, { ...stuckInputs, readbackModel: "050", nowMs: NOW_MS + 4 * 60_000 }, settings) ===
      NOT_STUCK_OFF_GRID
  );
  check(
    "151 requested and read is not stuck",
    !trackStuckOffGrid(threeMinutes, { ...stuckInputs, requestedModel: "151" }, settings).stuck
  );
}

// ---------- the switch-back resend back-off: at once, then 1, 2, 5 min, then every 10 min ----------
{
  check("the first DM050 is due at once", switchBackResendDue(NO_SWITCH_BACK_SENDS, NOW_MS));
  const sendTimes: number[] = [];
  let sends = NO_SWITCH_BACK_SENDS;
  for (let secondsElapsed = 0; secondsElapsed <= 3600; secondsElapsed += 10) {
    const nowMs = NOW_MS + secondsElapsed * 1000;
    if (!switchBackResendDue(sends, nowMs)) continue;
    sendTimes.push(secondsElapsed);
    sends = { count: sends.count + 1, lastAtMs: nowMs };
  }
  check(
    "an hour of a refused DM050 sends 9 of them, at 0, 1, 3, 8, 18, 28 … min",
    sendTimes.join(",") === "0,60,180,480,1080,1680,2280,2880,3480",
    sendTimes.join(",")
  );
}

// ---------- DM polling backs off when it goes unanswered ----------
{
  check("DM is polled by default", machineModelPollDue(INITIAL_MACHINE_MODEL_POLL_STATE, NOW_MS, true));
  check(
    "grid_off.poll_machine_model off: DM sits every round out",
    !machineModelPollDue(INITIAL_MACHINE_MODEL_POLL_STATE, NOW_MS, false)
  );
  const firstFailure = afterMachineModelQuery(INITIAL_MACHINE_MODEL_POLL_STATE, false, NOW_MS);
  check(
    "one unanswered DM: still polled",
    !firstFailure.startedBackoff && machineModelPollDue(firstFailure.state, NOW_MS, true)
  );
  const secondFailure = afterMachineModelQuery(firstFailure.state, false, NOW_MS + 1000);
  check(
    "two in a row: backed off for 30 min",
    secondFailure.startedBackoff &&
      !machineModelPollDue(secondFailure.state, NOW_MS + 1000 + MACHINE_MODEL_POLL_BACKOFF_MS - 1, true) &&
      machineModelPollDue(secondFailure.state, NOW_MS + 1000 + MACHINE_MODEL_POLL_BACKOFF_MS, true)
  );
  const retryFailure = afterMachineModelQuery(secondFailure.state, false, NOW_MS + 2 * MACHINE_MODEL_POLL_BACKOFF_MS);
  check("the retry after the back-off failing backs off again", retryFailure.startedBackoff);
  check(
    "an answer clears it",
    afterMachineModelQuery(retryFailure.state, true, NOW_MS).state === INITIAL_MACHINE_MODEL_POLL_STATE
  );
}

// ---------- the knobs ----------
{
  const { settings: defaults, corrections } = effectiveGridOffSettings(DEFAULT_GRID_OFF_SETTINGS);
  check(
    "the defaults (10 %, 5 %, 10 min, 5 s, 60 s, 3 min, polling on) pass uncorrected",
    defaults.min_soc_percent === 10 &&
      defaults.switch_on_soc_margin_percent === 5 &&
      defaults.reconnect_before_window_minutes === 10 &&
      defaults.shutdown_wait_seconds === 5 &&
      defaults.min_seconds_between_switches === 60 &&
      defaults.stuck_p1_after_minutes === 3 &&
      defaults.poll_machine_model &&
      corrections.length === 0
  );
  check(
    "a missing section takes the defaults, with a correction each (the profile as a whole: one)",
    effectiveGridOffSettings(undefined).settings.min_soc_percent === 10 &&
      effectiveGridOffSettings(undefined).settings.normal_energy_distribution.solar_energy_distribution_priority ===
        "Load-Battery-Grid" &&
      effectiveGridOffSettings(undefined).corrections.length === 10,
    effectiveGridOffSettings(undefined).corrections.join(" | ")
  );
  const clamped = effectiveGridOffSettings({
    ...DEFAULT_GRID_OFF_SETTINGS,
    min_soc_percent: 2,
    reconnect_before_window_minutes: "soon",
    shutdown_wait_seconds: 600,
  });
  check(
    "out-of-bounds knobs are clamped, a non-number falls back, each with a correction",
    clamped.settings.min_soc_percent === 5 &&
      clamped.settings.reconnect_before_window_minutes === 10 &&
      clamped.settings.shutdown_wait_seconds === 20 &&
      clamped.corrections.length === 3
  );
}
{
  const merged = mergeWithDefaults({} as Partial<Config>);
  check("a config.json without grid_off gets the defaults", merged.grid_off.min_soc_percent === 10);
  const partial = mergeWithDefaults({ grid_off: { min_soc_percent: 20 } } as unknown as Partial<Config>);
  check(
    "grid_off merges key by key",
    partial.grid_off.min_soc_percent === 20 &&
      partial.grid_off.reconnect_before_window_minutes === default_config.grid_off.reconnect_before_window_minutes
  );
}

console.log(`\n${fails.length ? `${fails.length} FAILED: ${fails.join(", ")}` : "all gridOff selftests passed"}`);
process.exit(fails.length ? 1 : 0);
