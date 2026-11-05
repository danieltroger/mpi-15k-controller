/**
 * Self-test of the energy-distribution restore after a machine model change: the profile and its setters,
 * the pure episode decisions, and the live wiring inside createGridOffSwitch with plain signals standing in
 * for the inverter session and the clock. No hardware. Run from backend/ with:
 *   yarn node src/gridOff/energyDistributionRestore.selftest.ts
 */
import process from "process";
import { createRoot, createSignal } from "solid-js";
import { default_config } from "../config/config.ts";
import type { Config } from "../config/config.types.ts";
import type { DecodedFields, DecodedRound } from "../inverterComms/pi17Protocol.types.ts";
import type { SetterQueueItem } from "../inverterComms/inverterComms.types.ts";
import type { AlertManager } from "../alerting/alertManager.ts";
import { expectedReadbackChecksForSetter } from "../inverterComms/setterConfirmation.ts";
import { createGridOffSwitch } from "./useGridOffSwitch.ts";
import {
  DEFAULT_NORMAL_ENERGY_DISTRIBUTION,
  effectiveNormalEnergyDistribution,
  energyDistributionFromHecs,
  energyDistributionMismatches,
  restoreSetterFor,
} from "./energyDistributionProfile.ts";
import {
  manualRestoreRefusal,
  nextRestoreStep,
  RESTORE_RESEND_INTERVALS_MS,
  restoreTriggerOnReadback,
  startRestoreEpisode,
  type RestoreTiming,
} from "./energyDistributionRestoreDecisions.ts";
import type { EnergyDistributionSnapshot, EnergyDistributionSnapshotStore } from "./energyDistributionSnapshotStore.ts";

const fails: string[] = [];
function check(name: string, condition: boolean, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}: ${name} ${detail}`);
  if (!condition) fails.push(name);
}

/** HECS as the live inverter read it before the DM050 of 2026-11-05 (the profile's defaults) */
const LIVE_NORMAL_HECS: DecodedFields = {
  solar_energy_distribution_priority: "Load-Battery-Grid",
  solar_charge_battery: "enabled",
  ac_charge_battery: "disabled",
  feed_power_to_utility: "enabled",
  battery_discharge_to_loads_when_solar_input_normal: "enabled",
  battery_discharge_to_loads_when_solar_input_loss: "enabled",
  battery_discharge_to_feed_grid_when_solar_input_normal: "enabled",
  battery_discharge_to_feed_grid_when_solar_input_loss: "enabled",
};
/** …and what it read once DM050 had applied: the factory defaults */
const AFTER_DM_RESET_HECS: DecodedFields = {
  ...LIVE_NORMAL_HECS,
  solar_energy_distribution_priority: "Battery-Load-Grid",
  ac_charge_battery: "enabled",
  battery_discharge_to_loads_when_solar_input_normal: "disabled",
  battery_discharge_to_loads_when_solar_input_loss: "disabled",
  battery_discharge_to_feed_grid_when_solar_input_normal: "disabled",
  battery_discharge_to_feed_grid_when_solar_input_loss: "disabled",
};

const warnLines: string[] = [];
const originalWarn = console.warn;
console.warn = (...args: unknown[]) => {
  warnLines.push(args.map(argument => String(argument)).join(" "));
  originalWarn(...args);
};

// ---------- the profile and its setters ----------
{
  check(
    "the default profile is the live one of 2026-11-05",
    energyDistributionMismatches(DEFAULT_NORMAL_ENERGY_DISTRIBUTION, LIVE_NORMAL_HECS).length === 0
  );
  const mismatches = energyDistributionMismatches(DEFAULT_NORMAL_ENERGY_DISTRIBUTION, AFTER_DM_RESET_HECS);
  check(
    "after the reset: priority first, then discharge to the loads with and without PV; EDB/EDF/EDG not ours",
    mismatches.map(mismatch => mismatch.field).join(",") ===
      "solar_energy_distribution_priority,battery_discharge_to_loads_when_solar_input_normal,battery_discharge_to_loads_when_solar_input_loss",
    JSON.stringify(mismatches)
  );
  const commands = mismatches.map(mismatch => restoreSetterFor(mismatch, DEFAULT_NORMAL_ENERGY_DISTRIBUTION));
  check(
    "…restored with SEP01, EDD1, EDE1, each replacing its own parameter",
    commands.map(setter => `${setter.command}/${setter.replacesPrefix}`).join(",") === "SEP01/SEP,EDD1/EDD,EDE1/EDE"
  );
  check(
    "EDA0 and EDC1 for the other two fields",
    restoreSetterFor(
      { field: "solar_charge_battery", live: "enabled", wanted: "disabled" },
      { ...DEFAULT_NORMAL_ENERGY_DISTRIBUTION, solar_charge_battery: "disabled" }
    ).command === "EDA0" &&
      restoreSetterFor(
        { field: "feed_power_to_utility", live: "disabled", wanted: "enabled" },
        DEFAULT_NORMAL_ENERGY_DISTRIBUTION
      ).command === "EDC1"
  );
  const priorityChecks = ["SEP00", "SEP01", "SEP02"].map(command => expectedReadbackChecksForSetter(command)[0]);
  check(
    "SEPnn is confirmed by HECS's priority text",
    priorityChecks
      .map(readbackCheck => `${readbackCheck?.query}:${readbackCheck?.field}=${readbackCheck?.expectedValue}`)
      .join(",") ===
      "HECS:solar_energy_distribution_priority=Battery-Load-Grid,HECS:solar_energy_distribution_priority=Load-Battery-Grid,HECS:solar_energy_distribution_priority=Load-Grid-Battery"
  );
  check(
    "EDA/EDC/EDD/EDE are confirmed by their HECS flags",
    ["EDA1", "EDC0", "EDD1", "EDE0"]
      .map(command => expectedReadbackChecksForSetter(command)[0])
      .map(readbackCheck => `${readbackCheck?.field}=${readbackCheck?.expectedValue}`)
      .join(",") ===
      "solar_charge_battery=enabled,feed_power_to_utility=disabled,battery_discharge_to_loads_when_solar_input_normal=enabled,battery_discharge_to_loads_when_solar_input_loss=disabled"
  );
  check("SEP03 has no readback (not a priority)", expectedReadbackChecksForSetter("SEP03").length === 0);

  const corrected = effectiveNormalEnergyDistribution({
    solar_energy_distribution_priority: "Grid-First",
    solar_charge_battery: true,
    feed_power_to_utility: "disabled",
  });
  check(
    "a hand-edited profile is corrected field by field, with a sentence each",
    corrected.profile.solar_energy_distribution_priority === "Load-Battery-Grid" &&
      corrected.profile.solar_charge_battery === "enabled" &&
      corrected.profile.feed_power_to_utility === "disabled" &&
      corrected.profile.battery_discharge_to_loads_when_solar_input_normal === "enabled" &&
      corrected.corrections.length === 4,
    corrected.corrections.join(" | ")
  );
  check(
    "a profile that isn't an object falls back to the defaults",
    effectiveNormalEnergyDistribution("enabled").corrections.length === 1
  );
  check(
    "a HECS readback with an undecodable priority makes no snapshot",
    energyDistributionFromHecs({ ...LIVE_NORMAL_HECS, solar_energy_distribution_priority: "Unknown key: 07" }) ===
      undefined && energyDistributionFromHecs(LIVE_NORMAL_HECS) !== undefined
  );
}

// ---------- the pure decisions ----------
{
  check(
    "the first DM readback since the start starts nothing",
    restoreTriggerOnReadback(undefined, "050").action === "none"
  );
  check("050 → 050 starts nothing", restoreTriggerOnReadback("050", "050").action === "none");
  check("151 → 050 starts an episode", restoreTriggerOnReadback("151", "050").action === "start");
  check("050 → 151 cancels (no writes in Off-Grid III)", restoreTriggerOnReadback("050", "151").action === "cancel");

  const timing: RestoreTiming = {
    resendIntervalsMs: RESTORE_RESEND_INTERVALS_MS,
    readbackRequestRepeatMs: 60_000,
    p2AfterMs: 600_000,
  };
  const onsetMs = 1_000_000;
  let episode = startRestoreEpisode("dm_change", onsetMs, 90_000);
  const reset = { fields: AFTER_DM_RESET_HECS, decodedAtMs: onsetMs - 2_000 };
  const profile = DEFAULT_NORMAL_ENERGY_DISTRIBUTION;
  let decision = nextRestoreStep(episode, { nowMs: onsetMs + 30_000, hecs: reset, profile }, timing);
  check("settling: nothing before the delay", decision.step.action === "wait");
  decision = nextRestoreStep(episode, { nowMs: onsetMs + 90_000, hecs: reset, profile }, timing);
  check(
    "after the delay the HECS read beside the DM confirm isn't trusted: a fresh one is asked for",
    decision.step.action === "request_readback"
  );
  episode = decision.episode;
  decision = nextRestoreStep(episode, { nowMs: onsetMs + 100_000, hecs: reset, profile }, timing);
  check("…once, not every tick", decision.step.action === "wait");
  decision = nextRestoreStep(episode, { nowMs: onsetMs + 151_000, hecs: reset, profile }, timing);
  check("…and again after the request's lifetime", decision.step.action === "request_readback");
  const fresh = { fields: AFTER_DM_RESET_HECS, decodedAtMs: onsetMs + 95_000 };
  decision = nextRestoreStep(episode, { nowMs: onsetMs + 96_000, hecs: fresh, profile }, timing);
  check(
    "a fresh readback that differs sends the three setters",
    decision.step.action === "send" && decision.step.mismatches.length === 3 && decision.episode.sendRounds === 1
  );
  episode = decision.episode;
  const sendTimes: number[] = [];
  let p2Count = 0;
  for (let nowMs = onsetMs + 96_000; nowMs <= onsetMs + 3_600_000; nowMs += 10_000) {
    const tick = nextRestoreStep(episode, { nowMs, hecs: { ...fresh, decodedAtMs: nowMs }, profile }, timing);
    if (tick.step.action === "send") sendTimes.push(nowMs - onsetMs);
    if (tick.raiseP2) p2Count++;
    episode = tick.episode;
  }
  check(
    "a readback that never lands is resent 1, 2, 5 min after the previous round, then every 10 min",
    sendTimes.slice(0, 4).join(",") === "156000,276000,576000,1176000" &&
      sendTimes.slice(4).every((sentAt, index) => sentAt - (sendTimes[index + 3] ?? 0) === 600_000),
    sendTimes.join(",")
  );
  check("exactly one P2 in an hour of it", p2Count === 1);
  decision = nextRestoreStep(
    episode,
    { nowMs: onsetMs + 3_700_000, hecs: { fields: LIVE_NORMAL_HECS, decodedAtMs: onsetMs + 3_700_000 }, profile },
    timing
  );
  check(
    "a readback that matches ends it, with what differed at the start for the log",
    decision.step.action === "done" && decision.step.firstMismatches.length === 3
  );

  let silentEpisode = startRestoreEpisode("dm_change", onsetMs, 90_000);
  let silentP2s = 0;
  let silentP2AtMs: number | undefined;
  for (let nowMs = onsetMs; nowMs <= onsetMs + 3_600_000; nowMs += 10_000) {
    const silentTick = nextRestoreStep(silentEpisode, { nowMs, hecs: reset, profile }, timing);
    if (silentTick.raiseP2) {
      silentP2s++;
      silentP2AtMs ??= nowMs - onsetMs;
    }
    silentEpisode = silentTick.episode;
  }
  check(
    "a HECS that never reads back after the switch pages too: one P2, the knob after the settling",
    silentP2s === 1 && silentP2AtMs === 690_000,
    `${silentP2s} at ${silentP2AtMs}`
  );

  const calm = { gridOffInForce: false, readbackModel: "050", readingsStaleness: undefined, activeWindow: undefined };
  check("the page may restore in 050 with fresh readings and no window", manualRestoreRefusal(calm) === undefined);
  check("…not while grid-off is in force", manualRestoreRefusal({ ...calm, gridOffInForce: true }) !== undefined);
  check("…not while the inverter reads 151", manualRestoreRefusal({ ...calm, readbackModel: "151" }) !== undefined);
  check("…not on stale readings", manualRestoreRefusal({ ...calm, readingsStaleness: "old" }) !== undefined);
  check(
    "…not during a window",
    manualRestoreRefusal({ ...calm, activeWindow: "a buy window is active" })?.includes("buy window") === true
  );
}

// ---------- the live wiring ----------
const START_MS = Date.parse("2026-11-05T12:00:00Z");

type Harness = ReturnType<typeof startHarness>;

function memorySnapshotStore(initial: EnergyDistributionSnapshot | undefined) {
  const store = { current: initial, saves: 0, clears: 0 };
  const api: EnergyDistributionSnapshotStore = {
    load: () => store.current,
    save: snapshot => {
      store.current = snapshot;
      store.saves++;
    },
    clear: () => {
      store.current = undefined;
      store.clears++;
    },
  };
  return { store, api };
}

function startHarness(initialSnapshot: EnergyDistributionSnapshot | undefined = undefined) {
  const clock = { nowMs: START_MS, readingsAtMs: START_MS };
  const [config, setConfig] = createSignal<Config>(default_config);
  const [lastDecodedRound, setLastDecodedRound] = createSignal<DecodedRound | undefined>(undefined);
  const [soc] = createSignal<number | undefined>(60);
  const queued: SetterQueueItem[] = [];
  const readbackRequests: string[] = [];
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
  const snapshotStore = memorySnapshotStore(initialSnapshot);
  let gridOffSwitch: ReturnType<typeof createGridOffSwitch> | undefined;
  const dispose = createRoot(disposeRoot => {
    gridOffSwitch = createGridOffSwitch({
      config,
      queueSetter: item => queued.push(item),
      requestSettingsReadback: query => readbackRequests.push(query),
      lastDecodedRound,
      mqttValues,
      soc,
      raise,
      wallClockNowMs: () => clock.nowMs,
      energyDistributionSnapshotStore: snapshotStore.api,
      restoreTimingOverrides: undefined,
    });
    return disposeRoot;
  });
  if (!gridOffSwitch) throw new Error("createGridOffSwitch returned nothing");
  const readDm = (model: string) =>
    setLastDecodedRound({ command: "DM", wireCommand: "DM", fields: { machine_model: model }, decodedAt: clock.nowMs });
  const readHecs = (fields: DecodedFields) =>
    setLastDecodedRound({ command: "HECS", wireCommand: "HECS", fields: { ...fields }, decodedAt: clock.nowMs });
  return {
    clock,
    config,
    setConfig,
    queued,
    readbackRequests,
    raised,
    readDm,
    readHecs,
    snapshotStore,
    gridOffSwitch,
    dispose,
  };
}

function advance(harness: Harness, milliseconds: number): void {
  harness.clock.nowMs += milliseconds;
  harness.clock.readingsAtMs = harness.clock.nowMs;
}

/** A restore run as the 10 s guard tick does it (wall-clock, so the harness nudges a tracked input) */
function tick(harness: Harness): void {
  harness.setConfig({ ...harness.config() });
}

function restoreCommands(harness: Harness): string[] {
  return harness.queued.map(item => item.command).filter(command => /^(SEP|ED[ACDE])/.test(command));
}

function acknowledgeQueued(harness: Harness, fromIndex: number, acknowledged: boolean): void {
  for (const item of harness.queued.slice(fromIndex)) item.onResult?.({ acknowledged });
}

// No DM change, whatever HECS reads: nothing is written (the restore is inert), one warnLog at startup
{
  const harness = startHarness();
  const warnsBefore = warnLines.length;
  harness.readDm("050");
  harness.readHecs(AFTER_DM_RESET_HECS);
  for (let minute = 0; minute < 30; minute++) {
    advance(harness, 60_000);
    tick(harness);
    if (minute % 5 === 0) {
      harness.readHecs(AFTER_DM_RESET_HECS);
      harness.readDm("050");
    }
  }
  check("no DM change: nothing queued in 30 min of 050 and a reset HECS", harness.queued.length === 0);
  check("…and no readback asked for", harness.readbackRequests.length === 0);
  const startupWarns = warnLines
    .slice(warnsBefore)
    .filter(line => line.includes("energy-distribution settings differ"));
  check("…one warnLog about the difference, not one per readback", startupWarns.length === 1, startupWarns.join(" | "));
  const status = harness.gridOffSwitch.status().energy_distribution;
  check(
    "status lists the three differing fields against the config profile",
    status.profile_source === "config" &&
      status.mismatches?.map(mismatch => mismatch.field).join(",") ===
        "solar_energy_distribution_priority,battery_discharge_to_loads_when_solar_input_normal,battery_discharge_to_loads_when_solar_input_loss" &&
      status.restore === undefined
  );

  // ---------- the page's restore fixes it ----------
  const reply = await harness.gridOffSwitch.requestSettingsRestore();
  check("the manual restore asks for a fresh HECS first", harness.readbackRequests.join(",") === "HECS", reply);
  check("…and sends nothing on the old readback", harness.queued.length === 0);
  advance(harness, 3_000);
  harness.readHecs(AFTER_DM_RESET_HECS);
  check(
    "the fresh readback queues SEP01, EDD1, EDE1 in that order",
    restoreCommands(harness).join(",") === "SEP01,EDD1,EDE1"
  );
  check(
    "…each with a HECS refresh",
    harness.queued.every(item => item.refreshAfterSend.join(",") === "HECS")
  );
  acknowledgeQueued(harness, 0, true);
  advance(harness, 10_000);
  harness.readHecs(LIVE_NORMAL_HECS);
  check("restored: the episode ends", harness.gridOffSwitch.status().energy_distribution.restore === undefined);
  check("…the status matches", harness.gridOffSwitch.status().energy_distribution.mismatches?.length === 0);
  harness.dispose();
}

// A grid-off episode: the snapshot, the DM change back, the settle delay, the restore
{
  const harness = startHarness();
  harness.readDm("050");
  harness.readHecs(LIVE_NORMAL_HECS);
  advance(harness, 61_000);
  await harness.gridOffSwitch.requestOffGrid();
  check(
    "DM151 snapshots the HECS read in 050",
    harness.snapshotStore.store.saves === 1 &&
      harness.snapshotStore.store.current?.profile.solar_energy_distribution_priority === "Load-Battery-Grid" &&
      harness.gridOffSwitch.status().energy_distribution.profile_source === "snapshot"
  );
  harness.queued.at(-1)?.onResult?.({ acknowledged: true });
  advance(harness, 12_000);
  harness.readHecs({ ...AFTER_DM_RESET_HECS, battery_discharge_to_loads_when_solar_input_normal: "enabled" });
  harness.readDm("151");
  for (let step = 0; step < 6; step++) {
    advance(harness, 10_000);
    tick(harness);
  }
  check("in 151 nothing is restored (no HECS writes off the grid)", restoreCommands(harness).length === 0);
  advance(harness, 600_000);
  await harness.gridOffSwitch.requestNormal();
  const queuedAtNormal = harness.queued.length;
  check("the page's 050 queues DM050", harness.queued.at(-1)?.command === "DM050");
  advance(harness, 12_000);
  // The confirm reads HECS before DM: this one predates the reset
  harness.readHecs(LIVE_NORMAL_HECS);
  harness.readDm("050");
  check(
    "the DM050 readback starts a restore episode",
    harness.gridOffSwitch.status().energy_distribution.restore?.trigger === "dm_change"
  );
  harness.readHecs(AFTER_DM_RESET_HECS);
  for (let step = 0; step < 8; step++) {
    advance(harness, 10_000);
    tick(harness);
  }
  check("nothing sent during the 90 s settle", harness.queued.length === queuedAtNormal);
  advance(harness, 15_000);
  tick(harness);
  check("after it a fresh HECS is asked for", harness.readbackRequests.at(-1) === "HECS");
  advance(harness, 3_000);
  harness.readHecs(AFTER_DM_RESET_HECS);
  check(
    "…and the reset fields go out: SEP01, EDD1, EDE1",
    restoreCommands(harness).join(",") === "SEP01,EDD1,EDE1",
    restoreCommands(harness).join(",")
  );
  acknowledgeQueued(harness, queuedAtNormal, true);
  advance(harness, 10_000);
  harness.readHecs({ ...LIVE_NORMAL_HECS, ac_charge_battery: "enabled" });
  check(
    "restored (AC charge left to buying): the episode ends and the snapshot is dropped",
    harness.gridOffSwitch.status().energy_distribution.restore === undefined &&
      harness.snapshotStore.store.clears === 1 &&
      harness.gridOffSwitch.status().energy_distribution.profile_source === "config"
  );
  check("no P2 for a restore that landed", harness.raised.length === 0);
  for (let step = 0; step < 30; step++) {
    advance(harness, 10_000);
    tick(harness);
  }
  check("nothing more written afterwards", restoreCommands(harness).length === 3);
  harness.dispose();
}

// A persistent NAK: one P2 per episode, then a P3 once it lands
{
  const harness = startHarness();
  harness.readDm("151");
  check("the startup fail-safe queues DM050", harness.queued.at(-1)?.command === "DM050");
  advance(harness, 12_000);
  harness.readDm("050");
  harness.readHecs(AFTER_DM_RESET_HECS);
  advance(harness, 91_000);
  tick(harness);
  advance(harness, 2_000);
  const stillReset = { ...AFTER_DM_RESET_HECS };
  harness.readHecs(stillReset);
  check("the restore after the fail-safe's 151 → 050 goes out", restoreCommands(harness).length === 3);
  const roundsAt: number[] = [];
  let sent = harness.queued.length;
  acknowledgeQueued(harness, 0, false);
  for (let step = 0; step < 6 * 30; step++) {
    advance(harness, 10_000);
    harness.readHecs(stillReset);
    if (harness.queued.length > sent) {
      roundsAt.push(harness.clock.nowMs);
      acknowledgeQueued(harness, sent, false);
      sent = harness.queued.length;
    }
  }
  const p2s = harness.raised.filter(alert => alert.severity === "P2");
  check("30 min of NAKs: exactly one P2", p2s.length === 1, p2s.map(alert => alert.key).join(","));
  check("…on the episode's own key", p2s[0]?.key.startsWith("grid-off-settings-restore:") === true);
  // Rounds 2–6 at +1, +3, +8, +18 and +28 min: the back-off, not one a minute
  check("…resent with back-off (5 more rounds in 30 min, not 30)", roundsAt.length === 5, `${roundsAt.length}`);
  harness.readHecs(LIVE_NORMAL_HECS);
  const resolved = harness.raised.filter(alert => alert.severity === "P3");
  check(
    "landing at last sends one P3",
    resolved.length === 1 && harness.gridOffSwitch.status().energy_distribution.restore === undefined
  );
  harness.dispose();
}

// A restart mid-episode: the snapshot comes back from disk, nothing is written on its own
{
  const snapshot: EnergyDistributionSnapshot = {
    taken_at: START_MS - 3_600_000,
    profile: { ...DEFAULT_NORMAL_ENERGY_DISTRIBUTION, solar_energy_distribution_priority: "Load-Grid-Battery" },
  };
  const harness = startHarness(snapshot);
  harness.readDm("050");
  harness.readHecs(AFTER_DM_RESET_HECS);
  for (let step = 0; step < 30; step++) {
    advance(harness, 10_000);
    tick(harness);
  }
  const status = harness.gridOffSwitch.status().energy_distribution;
  check(
    "after a restart the snapshot is the profile, and nothing is written",
    status.profile_source === "snapshot" &&
      status.mismatches?.[0]?.wanted === "Load-Grid-Battery" &&
      harness.queued.length === 0
  );
  harness.clock.nowMs = Date.parse("2026-11-05T12:30:00Z");
  harness.clock.readingsAtMs = harness.clock.nowMs;
  harness.setConfig({
    ...harness.config(),
    scheduled_power_buying: {
      ...harness.config().scheduled_power_buying,
      schedule: { "2026-11-05T12:00:00Z": { end_time: "2026-11-05T13:00:00Z", charging_power: 0 } },
    },
  } as Config);
  let refusal = "";
  try {
    await harness.gridOffSwitch.requestSettingsRestore();
  } catch (error) {
    refusal = error instanceof Error ? error.message : String(error);
  }
  check("the page's restore is refused during a buy/hold window", refusal.includes("buy window is active"), refusal);
  check("…nothing queued", harness.queued.length === 0);
  harness.dispose();
}

console.warn = originalWarn;
console.log(
  `\n${fails.length ? `${fails.length} FAILED: ${fails.join(", ")}` : "all energyDistributionRestore selftests passed"}`
);
process.exit(fails.length ? 1 : 0);
