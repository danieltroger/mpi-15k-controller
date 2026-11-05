/**
 * Self-test of the grid-off switch's live wiring (createGridOffSwitch) with plain signals standing in for
 * the inverter session, the SOC and the clock: what it queues, when, and what it reports. No hardware. Run
 * from backend/ with:
 *   yarn node src/gridOff/gridOffSwitchWiring.selftest.ts
 */
import process from "process";
import { createRoot, createSignal } from "solid-js";
import { default_config } from "../config/config.ts";
import type { Config } from "../config/config.types.ts";
import type { DecodedRound } from "../inverterComms/pi17Protocol.types.ts";
import type { SetterQueueItem } from "../inverterComms/inverterComms.types.ts";
import type { AlertManager } from "../alerting/alertManager.ts";
import { createGridOffSwitch } from "./useGridOffSwitch.ts";
import { SWITCH_CONFIRM_DEADLINE_MS } from "./gridOffDecisions.ts";

const fails: string[] = [];
function check(name: string, condition: boolean, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}: ${name} ${detail}`);
  if (!condition) fails.push(name);
}

const START_MS = Date.parse("2026-11-03T22:00:00Z");
const signalListenersBefore = process.listenerCount("SIGTERM");

type Harness = ReturnType<typeof startHarness>;

function startHarness() {
  // readingsAtMs: GS/PS; socSampleAtMs: hall sensor 2, the SOC's input
  const clock = { nowMs: START_MS, readingsAtMs: START_MS, socSampleAtMs: START_MS };
  const [config, setConfig] = createSignal<Config>(default_config);
  const [lastDecodedRound, setLastDecodedRound] = createSignal<DecodedRound | undefined>(undefined);
  const [soc, setSoc] = createSignal<number | undefined>(60);
  const queued: SetterQueueItem[] = [];
  const raised: Parameters<AlertManager["raise"]>[0][] = [];
  const raise: AlertManager["raise"] = async alert => {
    raised.push(alert);
    return { ...alert, at: new Date(clock.nowMs).toISOString(), delivery: "dry_run" };
  };
  const mqttValues = {
    get battery_voltage() {
      return { value: 52.1, time: clock.readingsAtMs };
    },
    get ac_output_total_active_power() {
      return { value: 420, time: clock.readingsAtMs };
    },
  };
  let gridOffSwitch: ReturnType<typeof createGridOffSwitch> | undefined;
  const dispose = createRoot(disposeRoot => {
    gridOffSwitch = createGridOffSwitch({
      config,
      queueSetter: item => queued.push(item),
      lastDecodedRound,
      mqttValues,
      soc,
      socSampleAtMs: () => clock.socSampleAtMs,
      raise,
      wallClockNowMs: () => clock.nowMs,
    });
    return disposeRoot;
  });
  if (!gridOffSwitch) throw new Error("createGridOffSwitch returned nothing");
  const readBack = (model: string) =>
    setLastDecodedRound({ command: "DM", wireCommand: "DM", fields: { machine_model: model }, decodedAt: clock.nowMs });
  return { clock, setConfig, setSoc, queued, raised, readBack, gridOffSwitch, dispose };
}

/** Time passes with the inverter still talking; past grid_off.min_seconds_between_switches by default */
function advance(harness: Harness, milliseconds = 61_000): void {
  harness.clock.nowMs += milliseconds;
  harness.clock.readingsAtMs = harness.clock.nowMs;
  harness.clock.socSampleAtMs = harness.clock.nowMs;
}

/** A guard run: the 10 s tick is wall-clock, so the harness nudges a tracked input instead */
let nudge = 0;
function evaluateNow(harness: Harness): void {
  harness.setSoc(60 + ++nudge * 1e-9);
}

function sentCount(harness: Harness, command: string): number {
  return harness.queued.filter(item => item.command === command).length;
}

function lastCommand(harness: Harness): string | undefined {
  return harness.queued.at(-1)?.command;
}

async function refusalOf(harness: Harness): Promise<string | undefined> {
  try {
    await harness.gridOffSwitch.requestOffGrid();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function windowStartingIn(harness: Harness, minutes: number) {
  return {
    [new Date(harness.clock.nowMs + minutes * 60_000).toISOString()]: {
      end_time: new Date(harness.clock.nowMs + (minutes + 60) * 60_000).toISOString(),
      charging_power: 9000,
    },
  };
}

// ---------- inert: reading 050 at boot writes nothing ----------
{
  const harness = startHarness();
  check("nothing queued before the first DM readback", harness.queued.length === 0);
  harness.readBack("050");
  check("reading 050 at boot queues nothing (inert)", harness.queued.length === 0);
  const status = harness.gridOffSwitch.status();
  check(
    "status: 050 requested since start, 050 read back, not in force",
    status.requested_model === "050" &&
      status.requested_at === undefined &&
      status.readback_model === "050" &&
      !status.grid_off_in_force
  );
  check("no shutdown handler while not in force", process.listenerCount("SIGTERM") === signalListenersBefore);

  // ---------- the page switches off the grid ----------
  const result = await harness.gridOffSwitch.requestOffGrid();
  check("the request queues DM151", lastCommand(harness) === "DM151", result);
  check(
    "DM151 replaces any queued DM and re-reads every setting, DM last",
    harness.queued.at(-1)?.replacesPrefix === "DM" &&
      harness.queued.at(-1)?.refreshAfterSend.join(",") === "GPMP,HECS,BATS,DM"
  );
  check("grid-off is in force as soon as it is requested", harness.gridOffSwitch.gridOffInForce());
  check(
    "a shutdown handler is registered while in force",
    process.listenerCount("SIGTERM") === signalListenersBefore + 1
  );
  harness.queued.at(-1)?.onResult?.({ acknowledged: true });
  check(
    "the ACK shows as the latest event",
    harness.gridOffSwitch.status().last_event?.what.includes("ACKed") === true
  );
  const queuedBeforeReadback = harness.queued.length;
  harness.readBack("151");
  check("the 151 readback queues nothing more", harness.queued.length === queuedBeforeReadback);
  check("a second request is refused", (await refusalOf(harness))?.includes("already requested") === true);

  // ---------- guard (a): the SOC falls below the floor ----------
  harness.setSoc(9.5);
  check("SOC 9.5 % switches back: DM050 queued", lastCommand(harness) === "DM050");
  check("…the request is 050 again", harness.gridOffSwitch.status().requested_model === "050");
  check(
    "…and the event says why",
    harness.gridOffSwitch.status().last_event?.what.includes("min_soc_percent") === true,
    harness.gridOffSwitch.status().last_event?.what
  );
  check("still in force while the inverter reads 151", harness.gridOffSwitch.gridOffInForce());
  harness.readBack("050");
  check("not in force once it reads 050", !harness.gridOffSwitch.gridOffInForce());
  check("the shutdown handler is gone again", process.listenerCount("SIGTERM") === signalListenersBefore);

  // ---------- the rate limit ----------
  check(
    "a switch-off right after the guard's switch-back is refused (min_seconds_between_switches)",
    (await refusalOf(harness))?.includes("min_seconds_between_switches") === true
  );

  // ---------- preconditions ----------
  advance(harness);
  harness.setSoc(14);
  check("refused at 14 % (floor 10 + margin 5)", (await refusalOf(harness))?.includes("15 %") === true);
  harness.setSoc(60);
  harness.clock.readingsAtMs = harness.clock.nowMs - 90_000;
  check("refused on 90 s old readings", (await refusalOf(harness))?.includes("90 s old") === true);
  harness.clock.readingsAtMs = harness.clock.nowMs;
  // The hall sensor stops while the inverter keeps talking: the SOC then only counts the drain down
  harness.clock.socSampleAtMs = harness.clock.nowMs - 75_000;
  check(
    "refused from the page on a 75 s old hall sensor 2 sample",
    (await refusalOf(harness))?.includes("hall sensor 2, the SOC's input) is 75 s old") === true
  );
  harness.clock.socSampleAtMs = harness.clock.nowMs;
  harness.setConfig({
    ...default_config,
    scheduled_power_buying: { ...default_config.scheduled_power_buying, schedule: windowStartingIn(harness, 8) },
  });
  check(
    "refused 8 min before a buy window",
    (await refusalOf(harness))?.includes("buy window starts in 8 min") === true
  );

  // ---------- guard (b): a window comes within the lead ----------
  harness.setConfig(default_config);
  check("allowed again with the window gone", (await refusalOf(harness)) === undefined);
  harness.readBack("151");
  harness.setConfig({
    ...default_config,
    scheduled_power_buying: { ...default_config.scheduled_power_buying, schedule: windowStartingIn(harness, 5) },
  });
  check(
    "a buy window added 5 min out switches back at once",
    lastCommand(harness) === "DM050" &&
      harness.gridOffSwitch.status().requested_model === "050" &&
      harness.gridOffSwitch.status().last_event?.what.includes("buy window") === true
  );
  harness.readBack("050");
  harness.setConfig(default_config);

  // ---------- a NAK puts the request back ----------
  advance(harness);
  await harness.gridOffSwitch.requestOffGrid();
  harness.queued.at(-1)?.onResult?.({ acknowledged: false });
  check(
    "DM151 NAKed: the request goes back to 050, nothing more queued",
    harness.gridOffSwitch.status().requested_model === "050" && lastCommand(harness) === "DM151"
  );
  check("…and grid-off is no longer in force", !harness.gridOffSwitch.gridOffInForce());

  // ---------- the confirm deadline ----------
  advance(harness);
  await harness.gridOffSwitch.requestOffGrid();
  harness.clock.nowMs += SWITCH_CONFIRM_DEADLINE_MS + 1_000;
  harness.clock.readingsAtMs = harness.clock.nowMs;
  harness.clock.socSampleAtMs = harness.clock.nowMs;
  harness.setSoc(60.5);
  check(
    "151 never read back past the deadline: switched back",
    harness.gridOffSwitch.status().requested_model === "050" &&
      lastCommand(harness) === "DM050" &&
      harness.gridOffSwitch.status().last_event?.what.includes("after 151 was requested") === true,
    harness.gridOffSwitch.status().last_event?.what
  );

  // ---------- a late DM151 ACK after a guard's switch-back ----------
  advance(harness);
  harness.readBack("050");
  await harness.gridOffSwitch.requestOffGrid();
  const lateAck = harness.queued.at(-1);
  harness.setSoc(9);
  const guardEvent = harness.gridOffSwitch.status().last_event?.what;
  lateAck?.onResult?.({ acknowledged: true });
  check(
    "a DM151 ACK landing after the guard switched back leaves the guard's event",
    guardEvent?.startsWith("Guard switched back") === true &&
      harness.gridOffSwitch.status().last_event?.what === guardEvent,
    harness.gridOffSwitch.status().last_event?.what
  );
  harness.setSoc(60);

  // ---------- back to normal from the page ----------
  advance(harness);
  await harness.gridOffSwitch.requestOffGrid();
  harness.readBack("151");
  const normal = await harness.gridOffSwitch.requestNormal();
  check("the page's 050 queues DM050", lastCommand(harness) === "DM050", normal);
  check(
    "…and its event isn't overwritten by the pending switch-back",
    harness.gridOffSwitch.status().last_event?.what === "050 requested from the page",
    harness.gridOffSwitch.status().last_event?.what
  );
  harness.dispose();
}

// ---------- the startup fail-safe ----------
{
  const harness = startHarness();
  harness.readBack("151");
  check("reading 151 at startup queues DM050 at once", lastCommand(harness) === "DM050");
  check(
    "…said as the startup fail-safe",
    harness.gridOffSwitch.status().last_event?.what.includes("startup fail-safe") === true,
    harness.gridOffSwitch.status().last_event?.what
  );
  check("…grid-off in force until it reads 050", harness.gridOffSwitch.gridOffInForce());
  check("…refusing a switch-off meanwhile", (await refusalOf(harness))?.includes("already reads 151") === true);
  harness.readBack("050");
  check("…and over once it does", !harness.gridOffSwitch.gridOffInForce());
  check(
    "…and its DM050 counts as a switch: the next 151 waits min_seconds_between_switches",
    (await refusalOf(harness))?.includes("min_seconds_between_switches") === true
  );
  advance(harness);
  check("…a minute later it may go", (await refusalOf(harness)) === undefined);
  harness.dispose();
}

// ---------- the hall sensor stops while off the grid ----------
{
  const harness = startHarness();
  harness.readBack("050");
  await harness.gridOffSwitch.requestOffGrid();
  harness.readBack("151");
  advance(harness, 30_000);
  harness.clock.socSampleAtMs = harness.clock.nowMs - 61_000;
  evaluateNow(harness);
  check(
    "a hall sensor 2 sample 61 s old while off the grid: the guard switches back",
    lastCommand(harness) === "DM050" &&
      harness.gridOffSwitch.status().last_event?.what.includes("hall sensor 2") === true,
    harness.gridOffSwitch.status().last_event?.what
  );
  check(
    "…and that counts as a switch-off that didn't hold (automatic grid-off backs off on it)",
    harness.gridOffSwitch.offGridFailures().count === 1
  );
  harness.dispose();
}

// ---------- stuck on 151: every DM050 refused ----------
{
  const harness = startHarness();
  harness.readBack("151");
  check("startup 151: grid-off in force at first", harness.gridOffSwitch.gridOffInForce());
  const firstSwitchBack = harness.queued.at(-1);
  firstSwitchBack?.onResult?.({ acknowledged: false });
  // 30 min of 10 s guard runs, every DM050 NAKed, the inverter reading 151 throughout
  let pagedAtSeconds: number | undefined;
  let inForceAfterPage = true;
  for (let secondsElapsed = 10; secondsElapsed <= 30 * 60; secondsElapsed += 10) {
    advance(harness, 10_000);
    const queuedBefore = harness.queued.length;
    evaluateNow(harness);
    for (const item of harness.queued.slice(queuedBefore)) item.onResult?.({ acknowledged: false });
    if (pagedAtSeconds === undefined && harness.raised.some(alert => alert.severity === "P1")) {
      pagedAtSeconds = secondsElapsed;
      inForceAfterPage = harness.gridOffSwitch.gridOffInForce();
    }
  }
  const stuckPages = harness.raised.filter(alert => /^grid-off-stuck:\d+$/.test(alert.key));
  check(
    "a P1 after stuck_p1_after_minutes (3 min), once",
    stuckPages.length === 1 && stuckPages[0]!.severity === "P1" && pagedAtSeconds === 180,
    `paged at ${pagedAtSeconds} s, ${stuckPages.length} page(s)`
  );
  check("once stuck, grid-off is no longer in force: buying and the held alerts resume", !inForceAfterPage);
  check("…and the status says stuck", harness.gridOffSwitch.status().stuck_off_grid);
  check(
    "DM050 backs off: 6 sends in 30 min (0, 1, 3, 8, 18, 28 min), not 30",
    sentCount(harness, "DM050") === 6,
    `${sentCount(harness, "DM050")} sends`
  );
  check(
    "the P1 is keyed by its episode's onset (a second episode isn't swallowed by the cooldown)",
    stuckPages[0]?.key === `grid-off-stuck:${START_MS}`,
    stuckPages[0]?.key
  );
  check(
    "the shutdown switch-back still stands while stuck",
    process.listenerCount("SIGTERM") === signalListenersBefore + 1
  );
  harness.readBack("050");
  check(
    "reading 050 again resolves it with a P3",
    harness.raised.some(alert => alert.key === `${stuckPages[0]?.key}:resolved` && alert.severity === "P3") &&
      !harness.gridOffSwitch.status().stuck_off_grid
  );
  harness.dispose();
}

// ---------- a model the switch never writes ----------
{
  const harness = startHarness();
  harness.readBack("061");
  check("reading 061 queues nothing", harness.queued.length === 0);
  check(
    "…says it leaves it alone",
    harness.gridOffSwitch.status().last_event?.what.includes("leaving it alone") === true
  );
  check("…and refuses to switch from it", (await refusalOf(harness))?.includes("only supported from 050") === true);
  harness.dispose();
}

console.log(
  `\n${fails.length ? `${fails.length} FAILED: ${fails.join(", ")}` : "all gridOffSwitchWiring selftests passed"}`
);
process.exit(fails.length ? 1 : 0);
