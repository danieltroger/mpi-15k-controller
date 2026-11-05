/**
 * Self-test of automatic grid-off's live wiring: the real grid-off switch (createGridOffSwitch) driven by
 * createAutoGridOff, with plain signals standing in for the inverter session, the SOC, the energy-distribution
 * enforcement's status and the clock. Auto off writes nothing; auto on switches off, back for a window and off
 * again after it, follows the full and low SOC hysteresis, waits out the energy-settings restore and a failed
 * switch, refuses the page's buttons, hands back to 050 when turned off, and logs each change once. No
 * hardware. Run from backend/ with:
 *   yarn node src/gridOff/autoGridOffWiring.selftest.ts
 */
import process from "process";
import { createRoot, createSignal } from "solid-js";
import { default_config } from "../config/config.ts";
import type { Config } from "../config/config.types.ts";
import type { DecodedRound } from "../inverterComms/pi17Protocol.types.ts";
import type { SetterQueueItem } from "../inverterComms/inverterComms.types.ts";
import type { AlertManager } from "../alerting/alertManager.ts";
import type { EnergyDistributionStatus } from "../energyDistribution/energyDistribution.types.ts";
import { createGridOffSwitch } from "./useGridOffSwitch.ts";
import { createAutoGridOff } from "./useAutoGridOff.ts";

const fails: string[] = [];
function check(name: string, condition: boolean, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}: ${name} ${detail}`);
  if (!condition) fails.push(name);
}

// Every "Auto grid-off: wants …" line, to check each change of what it wants logs once
const autoLogLines: string[] = [];
const originalConsoleLog = console.log;
console.log = (...args: unknown[]) => {
  const line = args.map(argument => String(argument)).join(" ");
  if (line.includes("Auto grid-off: wants")) autoLogLines.push(line);
  originalConsoleLog(...args);
};

const START_MS = Date.parse("2026-11-05T21:00:00Z");
const MINUTE_MS = 60_000;

const AUTO_ON: Config = { ...default_config, grid_off: { ...default_config.grid_off, auto_enabled: true } };

type Harness = ReturnType<typeof startHarness>;

function startHarness(initialConfig: Config) {
  const clock = { nowMs: START_MS, readingsAtMs: START_MS };
  const [config, setConfig] = createSignal<Config>(initialConfig);
  const [lastDecodedRound, setLastDecodedRound] = createSignal<DecodedRound | undefined>(undefined);
  const [soc, setSoc] = createSignal<number | undefined>(60);
  const [energyStatus, setEnergyStatus] = createSignal<EnergyDistributionStatus | undefined>(undefined);
  const queued: SetterQueueItem[] = [];
  const raise: AlertManager["raise"] = async alert => ({
    ...alert,
    at: new Date(clock.nowMs).toISOString(),
    delivery: "dry_run",
  });
  const mqttValues = {
    get battery_voltage() {
      return { value: 52.1, time: clock.readingsAtMs };
    },
    get ac_output_total_active_power() {
      return { value: 420, time: clock.readingsAtMs };
    },
  };
  let built:
    | { gridOffSwitch: ReturnType<typeof createGridOffSwitch>; auto: ReturnType<typeof createAutoGridOff> }
    | undefined;
  const dispose = createRoot(disposeRoot => {
    const gridOffSwitch = createGridOffSwitch({
      config,
      queueSetter: item => queued.push(item),
      lastDecodedRound,
      mqttValues,
      soc,
      raise,
      wallClockNowMs: () => clock.nowMs,
    });
    const auto = createAutoGridOff({
      config,
      soc,
      gridOffSwitch,
      energyDistributionStatus: energyStatus,
      wallClockNowMs: () => clock.nowMs,
    });
    built = { gridOffSwitch, auto };
    return disposeRoot;
  });
  if (!built) throw new Error("the harness built nothing");
  const readBack = (model: string) =>
    setLastDecodedRound({ command: "DM", wireCommand: "DM", fields: { machine_model: model }, decodedAt: clock.nowMs });
  return { clock, config, setConfig, setSoc, soc, setEnergyStatus, queued, readBack, ...built, dispose };
}

/** Time passes with the inverter still talking, then the rules run (the 10 s ticks are wall-clock) */
function advance(harness: Harness, milliseconds: number): void {
  harness.clock.nowMs += milliseconds;
  harness.clock.readingsAtMs = harness.clock.nowMs;
  // The DM readback is refreshed by the settings rounds; keep it fresh as the inverter would
  const lastModel = harness.gridOffSwitch.status().readback_model;
  if (lastModel) harness.readBack(lastModel);
  evaluateNow(harness);
}

let nudge = 0;
function evaluateNow(harness: Harness): void {
  harness.setSoc((harness.soc() ?? 60) + (++nudge % 2 ? 1e-9 : -1e-9));
}

function commands(harness: Harness): string[] {
  return harness.queued.map(item => item.command);
}

function buyWindow(
  harness: Harness,
  startInMinutes: number,
  durationMinutes: number
): Config["scheduled_power_buying"]["schedule"] {
  return {
    [new Date(harness.clock.nowMs + startInMinutes * MINUTE_MS).toISOString()]: {
      end_time: new Date(harness.clock.nowMs + (startInMinutes + durationMinutes) * MINUTE_MS).toISOString(),
      charging_power: 100,
    },
  };
}

function withSchedule(base: Config, schedule: Config["scheduled_power_buying"]["schedule"]): Config {
  return { ...base, scheduled_power_buying: { ...base.scheduled_power_buying, schedule } };
}

async function refusalOf(request: () => Promise<string>): Promise<string | undefined> {
  try {
    await request();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function divergingStatus(): EnergyDistributionStatus {
  return {
    profile_name: "normal_hybrid",
    machine_model: "050",
    fields: [],
    hecs_read_at: START_MS,
    divergence: { since: START_MS, send_rounds: 1, fallback_only: false, p2_raised: false },
    unread_fields: undefined,
    waiting_reason: undefined,
    last_event: undefined,
  };
}

// ---------- auto off: nothing written, whatever happens ----------
{
  const harness = startHarness(withSchedule(default_config, {}));
  harness.readBack("050");
  for (const socPercent of [60, 97, 9, 50]) {
    harness.setSoc(socPercent);
    advance(harness, 10 * MINUTE_MS);
  }
  harness.setConfig(withSchedule(default_config, buyWindow(harness, 5, 60)));
  advance(harness, 90 * MINUTE_MS);
  check(
    "auto off: nothing queued over a night of SOC changes and a window",
    harness.queued.length === 0,
    commands(harness).join(",")
  );
  const status = harness.auto.status();
  check(
    "…and its status says off, wanting nothing",
    !status.enabled &&
      status.desired_model === undefined &&
      status.reason === undefined &&
      status.next_switch === undefined
  );
  check("…no 'wants' log line", autoLogLines.length === 0);
  harness.dispose();
}

// ---------- auto on: off the grid, back for a window, off again after it ----------
{
  const harness = startHarness(withSchedule(AUTO_ON, {}));
  check("nothing before the first DM readback", harness.queued.length === 0);
  harness.readBack("050");
  check(
    "reading 050 with nothing in the way: DM151 queued",
    commands(harness).join(",") === "DM151",
    commands(harness).join(",")
  );
  check(
    "…as an automatic request",
    harness.gridOffSwitch.status().last_event?.what.startsWith("151 requested automatically: DM151 queued") === true,
    harness.gridOffSwitch.status().last_event?.what
  );
  check(
    "…and the status wants 151",
    harness.auto.status().desired_model === "151" && harness.auto.status().reason_kind === "off_grid"
  );
  harness.queued.at(-1)?.onResult?.({ acknowledged: true });
  harness.readBack("151");
  for (let step = 0; step < 5; step++) advance(harness, MINUTE_MS);
  check("staying off: nothing more queued", harness.queued.length === 1);
  check(
    "'wants 151' logged once",
    autoLogLines.filter(line => line.includes("wants 151")).length === 1,
    String(autoLogLines.length)
  );
  check(
    "the page's back-to-normal is refused while auto is on",
    (await refusalOf(harness.gridOffSwitch.requestNormal))?.includes("automatic grid-off is on") === true
  );

  harness.setConfig(withSchedule(AUTO_ON, buyWindow(harness, 12, 60)));
  check("a buy window in 12 min: still off (the lead is 10)", harness.queued.length === 1);
  const nextSwitch = harness.auto.status().next_switch;
  check(
    "…and the next switch is the reconnect 10 min before it",
    nextSwitch?.model === "050" && nextSwitch.at === harness.clock.nowMs + 2 * MINUTE_MS,
    JSON.stringify(nextSwitch)
  );
  advance(harness, 2 * MINUTE_MS);
  check("10 min before it: DM050 queued", commands(harness).at(-1) === "DM050", commands(harness).join(","));
  check(
    "…the status says why",
    harness.auto.status().desired_model === "050" &&
      harness.auto.status().reason_kind === "window" &&
      harness.auto.status().reason?.includes("buy window at") === true,
    harness.auto.status().reason
  );
  const afterWindow = harness.auto.status().next_switch;
  check(
    "…and the next switch is off the grid when the window ends",
    afterWindow?.model === "151" && afterWindow.at === harness.clock.nowMs + 70 * MINUTE_MS,
    JSON.stringify(afterWindow)
  );
  harness.readBack("050");
  const queuedAtReconnect = harness.queued.length;
  // From 10 min before the window to 1 min before its end
  for (let step = 0; step < 6; step++) advance(harness, 10 * MINUTE_MS);
  advance(harness, 9 * MINUTE_MS);
  check(
    "through the window: nothing more queued",
    harness.queued.length === queuedAtReconnect,
    commands(harness).join(",")
  );
  advance(harness, MINUTE_MS);
  check("the window over: DM151 again", commands(harness).at(-1) === "DM151", commands(harness).join(","));
  check(
    "each change logged once: wants 050 (no DM readback yet), 151, 050 (the window), 151",
    autoLogLines.length === 4 &&
      autoLogLines[0]!.includes("wants 050") &&
      autoLogLines[0]!.includes("hasn't been read yet") &&
      autoLogLines[2]!.includes("wants 050") &&
      autoLogLines[2]!.includes("buy window") &&
      autoLogLines[3]!.includes("wants 151"),
    autoLogLines.join(" | ")
  );
  harness.readBack("151");

  // ---------- (a) the full battery and its hysteresis ----------
  const beforeFull = harness.queued.length;
  harness.setSoc(95);
  check(
    "95 % off the grid: DM050 (so the PV can export)",
    commands(harness).at(-1) === "DM050" && harness.queued.length === beforeFull + 1
  );
  harness.readBack("050");
  advance(harness, 2 * MINUTE_MS);
  harness.setSoc(92);
  advance(harness, MINUTE_MS);
  check(
    "92 % on the grid: stays on",
    harness.queued.length === beforeFull + 1 && harness.auto.status().reason_kind === "battery_above_resume"
  );
  harness.setSoc(89.9);
  check("89.9 %: DM151", commands(harness).at(-1) === "DM151");
  harness.readBack("151");

  // ---------- (c) the low battery and its hysteresis ----------
  const beforeLow = harness.queued.length;
  harness.setSoc(9.9);
  check("9.9 % off the grid: DM050", commands(harness).at(-1) === "DM050" && harness.queued.length === beforeLow + 1);
  harness.readBack("050");
  advance(harness, 2 * MINUTE_MS);
  harness.setSoc(14);
  advance(harness, MINUTE_MS);
  check(
    "14 % on the grid: stays on",
    harness.queued.length === beforeLow + 1 && harness.auto.status().reason_kind === "battery_low"
  );

  // ---------- (f) the energy settings being written back ----------
  harness.setEnergyStatus(divergingStatus());
  harness.setSoc(50);
  advance(harness, MINUTE_MS);
  check(
    "50 % but the 050 profile being written back: stays on",
    harness.queued.length === beforeLow + 1 && harness.auto.status().reason_kind === "energy_settings",
    harness.auto.status().reason
  );
  check(
    "the page's switch-off is refused while auto is on",
    (await refusalOf(harness.gridOffSwitch.requestOffGrid))?.includes("automatic grid-off is on") === true
  );
  // The restore landed, but one managed field is missing from the HECS answer (#92 tracks that on its own):
  // never written, so waiting for it would keep the inverter on the grid for good
  harness.setEnergyStatus({
    ...divergingStatus(),
    divergence: undefined,
    unread_fields: { fields: ["battery_discharge_to_loads_when_solar_input_loss"], since: START_MS, p2_raised: false },
  });
  check(
    "the restore landed, a field left unread: DM151 (only a read field that differs holds it back)",
    commands(harness).at(-1) === "DM151",
    commands(harness).join(",")
  );

  // ---------- a failed switch-off backs the next try off ----------
  harness.queued.at(-1)?.onResult?.({ acknowledged: false });
  check("DM151 NAKed: back to 050 requested", harness.gridOffSwitch.status().requested_model === "050");
  const afterNak = harness.queued.length;
  advance(harness, 2 * MINUTE_MS);
  check(
    "2 min later (past the rate limit): no retry, held back",
    harness.queued.length === afterNak && harness.auto.status().reason_kind === "retry_backoff",
    harness.auto.status().reason
  );
  advance(harness, 3 * MINUTE_MS);
  check("5 min after the NAK: retried", commands(harness).at(-1) === "DM151" && harness.queued.length === afterNak + 1);
  harness.readBack("151");
  advance(harness, MINUTE_MS);

  // ---------- turning it off hands back to 050 ----------
  const beforeDisable = harness.queued.length;
  harness.setConfig(withSchedule(default_config, {}));
  check(
    "turned off with the grid off: DM050 once",
    harness.queued.length === beforeDisable + 1 && commands(harness).at(-1) === "DM050",
    commands(harness).slice(beforeDisable).join(",")
  );
  check(
    "…said in the event",
    harness.gridOffSwitch.status().last_event?.what.includes("automatic grid-off was turned off") === true,
    harness.gridOffSwitch.status().last_event?.what
  );
  harness.readBack("050");
  for (let step = 0; step < 5; step++) advance(harness, 10 * MINUTE_MS);
  check("…and nothing after it", harness.queued.length === beforeDisable + 1, commands(harness).join(","));
  check("the page's buttons work again", (await refusalOf(harness.gridOffSwitch.requestOffGrid)) === undefined);
  harness.dispose();
}

// ---------- (d) a stretch too short to switch off for ----------
{
  const harness = startHarness(withSchedule(AUTO_ON, {}));
  harness.setConfig(withSchedule(AUTO_ON, buyWindow(harness, 65, 30)));
  harness.readBack("050");
  check(
    "a window in 65 min (55 min before its reconnect): stays on the grid",
    harness.queued.length === 0 && harness.auto.status().reason_kind === "short_stretch",
    harness.auto.status().reason
  );
  check(
    "…the next switch: off after that window",
    harness.auto.status().next_switch?.model === "151" &&
      harness.auto.status().next_switch?.at === harness.clock.nowMs + 95 * MINUTE_MS
  );
  harness.setConfig(withSchedule(AUTO_ON, buyWindow(harness, 75, 30)));
  check("moved to 75 min out (65 min): DM151", commands(harness).join(",") === "DM151");
  harness.dispose();
}

// ---------- turned off while on the grid: nothing to hand back ----------
{
  const harness = startHarness(withSchedule(AUTO_ON, {}));
  harness.setSoc(97);
  harness.readBack("050");
  check(
    "97 % at the start: stays on the grid",
    harness.queued.length === 0 && harness.auto.status().reason_kind === "battery_full"
  );
  harness.setConfig(withSchedule(default_config, {}));
  advance(harness, MINUTE_MS);
  check("turned off on the grid: nothing queued", harness.queued.length === 0);
  harness.dispose();
}

console.log = originalConsoleLog;
console.log(
  `\n${fails.length ? `${fails.length} FAILED: ${fails.join(", ")}` : "all autoGridOffWiring selftests passed"}`
);
process.exit(fails.length ? 1 : 0);
