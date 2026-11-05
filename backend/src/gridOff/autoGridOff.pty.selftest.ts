/**
 * End-to-end self-test of automatic grid-off: the real engine, the real grid-off switch, the real
 * energy-distribution enforcement and createAutoGridOff against fakePi17Inverter.py on a pty, the fake resetting
 * HECS on every DM change as the inverter did on 2026-11-05. The switch, the enforcement and automatic grid-off
 * run on a harness clock the test moves forward (the rounds they see carry it), so a window can approach and
 * pass without waiting for it; the engine keeps real time.
 *
 * Run 1, auto off: the inverter reads 050 with the live profile, and nothing is written.
 * Run 2, auto on: 151 at once; a buy window comes within the lead → 050; the enforcement writes the reset
 * profile back; nothing while the window runs; the window over → 151 again. Then a full battery → 050, and the
 * SOC back in the band at once: 151 waits for the enforcement's restore (and the rate limit) before it goes.
 *
 * Run from backend/ with:  yarn node src/gridOff/autoGridOff.pty.selftest.ts
 * Needs python3 and Linux ptys. Takes ~2.5 min: a second identical DM write waits out the engine's real-time
 * 60 s identical-setter gate.
 */
import process from "process";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "child_process";
import readline from "readline";
import { fileURLToPath } from "url";
import { createRoot, createSignal } from "solid-js";
import { createInverterSession } from "../inverterComms/inverterSession.ts";
import { createInverterStatusTracker } from "../inverterComms/useInverterStatus.ts";
import type { DecodedFields, DecodedRound } from "../inverterComms/pi17Protocol.types.ts";
import { IDENTICAL_SETTER_MIN_INTERVAL_MS, type SchedulerTiming } from "../inverterComms/schedulerTiming.ts";
import type { AlertManager } from "../alerting/alertManager.ts";
import { default_config } from "../config/config.ts";
import type { Config } from "../config/config.types.ts";
import { createEnergyDistributionEnforcement } from "../energyDistribution/useEnergyDistributionEnforcement.ts";
import type { AutoGridOffReasonKind } from "./gridOff.types.ts";
import { createGridOffSwitch } from "./useGridOffSwitch.ts";
import { createAutoGridOff } from "./useAutoGridOff.ts";

const FAKE_INVERTER_SCRIPT = fileURLToPath(new URL("../inverterComms/fakePi17Inverter.py", import.meta.url));
const HARD_TIMEOUT_MS = 300_000;
const HARNESS_TIMING: Partial<SchedulerTiming> = {
  firstConfirmAfterWriteMs: 1_000,
  confirmRecheckIntervalMs: 1_000,
  confirmGiveUpAfterWriteMs: 6_000,
  starvedWritePageAfterMs: 7_000,
};
/** What the live inverter read before the DM050 of 2026-11-05: the default 050 profile */
const LIVE_HECS_TOKENS = "01,1,0,1,1,1,1,1,0";
const ENFORCED_SETTER = /^\^S00[56](SEP|ED[ACDE])/;
const MINUTE_MS = 60_000;
/** The engine reads the settings this often, so a DM readback stays fresh across the harness clock's jumps */
const ENGINE_SETTINGS_POLL_SECONDS = 5;

type FakeInverterEvent =
  | { event: "ready"; device: string }
  | { event: "received"; command: string }
  | { event: "committed"; setter: string }
  | { event: "setter_refused"; setter: string }
  | { event: "hecs_reset"; cause: string; hecs: string }
  | { event: "summary" | "frame_sent" | "fault" | "faults_done" | "lost" | "garbage" | "unknown_query" };

const fails: string[] = [];
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name} ${detail}`);
  if (!cond) fails.push(name);
}

const hardTimeout = setTimeout(() => {
  console.error(`FAIL: the automatic grid-off run did not finish within ${HARD_TIMEOUT_MS} ms`);
  process.exit(1);
}, HARD_TIMEOUT_MS);

const python = spawnSync("python3", ["--version"], { encoding: "utf-8" });
if (python.status !== 0) {
  check("python3 is available for the fake inverter", false, String(python.error ?? python.stderr));
} else {
  await runAutoOffChecks();
  await runAutoOnChecks();
}
clearTimeout(hardTimeout);
console.log(
  `\n${fails.length ? `${fails.length} FAILED: ${fails.join(", ")}` : "all autoGridOff pty selftests passed"}`
);
process.exit(fails.length ? 1 : 0);

async function runAutoOffChecks(): Promise<void> {
  const fake = await startFakeInverter(["--no-faults", "--initial-hecs", LIVE_HECS_TOKENS]);
  const harness = startHarness(fake.device, configWith({ auto_enabled: false }, {}));
  await waitFor(() => latestModel(harness) === "050" && latestHecs(harness) !== undefined, 10_000);
  harness.setSoc(50);
  await sleep(6_000);
  check(
    "auto off: the inverter reads 050 and nothing at all is written",
    receivedSetters(fake.events).length === 0 && harness.auto.status().desired_model === undefined,
    receivedSetters(fake.events).join(",")
  );
  harness.dispose();
  await fake.stop();
}

async function runAutoOnChecks(): Promise<void> {
  const fake = await startFakeInverter(["--no-faults", "--initial-hecs", LIVE_HECS_TOKENS]);
  // A 15-min buy window 40 min out: 30 min off the grid before its reconnect, over auto_min_off_minutes 15
  const startMs = Date.now();
  const window = buyWindow(startMs + 40 * MINUTE_MS, startMs + 55 * MINUTE_MS);
  const harness = startHarness(
    fake.device,
    configWith({ auto_enabled: true, auto_min_off_minutes: 15, min_seconds_between_switches: 30 }, window)
  );
  await waitFor(() => latestModel(harness) === "151", 20_000);
  const firstOffGridAtMs = Date.now();
  check(
    "auto on: DM151 at once, read back as 151",
    latestModel(harness) === "151" && count(receivedSetters(fake.events), "^S006DM151") === 1,
    receivedSetters(fake.events).join(",")
  );
  check(
    "…in 151 (everything unmanaged) the reset HECS isn't written",
    receivedSetters(fake.events).every(command => !ENFORCED_SETTER.test(command))
  );

  // The window approaches: 25 min out, then 10 (the lead)
  harness.advanceClock(15 * MINUTE_MS);
  await sleep(3_000);
  check(
    "25 min before the window: still 151",
    latestModel(harness) === "151" && count(receivedSetters(fake.events), "^S006DM050") === 0
  );
  harness.advanceClock(15 * MINUTE_MS);
  await waitFor(() => latestModel(harness) === "050", 30_000);
  const firstOnGridAtMs = Date.now();
  check(
    "10 min before the window: DM050, read back as 050",
    latestModel(harness) === "050" && count(receivedSetters(fake.events), "^S006DM050") === 1,
    receivedSetters(fake.events).join(",")
  );
  check("…the status says the window", harness.auto.status().reason_kind === "window", harness.auto.status().reason);
  await waitFor(
    () => profileRestored(latestHecs(harness)) && harness.enforcement.status().divergence === undefined,
    60_000
  );
  check(
    "the enforcement writes the 050 profile back after the DM change's reset",
    profileRestored(latestHecs(harness)) && receivedSetters(fake.events).some(command => ENFORCED_SETTER.test(command)),
    JSON.stringify(latestHecs(harness))
  );

  // The window runs: nothing; then it is over
  harness.advanceClock(15 * MINUTE_MS);
  await sleep(4_000);
  check("while the window runs: no DM151", count(receivedSetters(fake.events), "^S006DM151") === 1);
  const enforcedBeforeSecond = lastCommittedEnforcedIndex(fake.events);
  // The engine keeps real time: its 60 s identical-setter gate would hold a second DM151 sooner (the default
  // min_seconds_between_switches, 60, keeps them that far apart live; the harness runs at 30)
  await sleep(Math.max(0, firstOffGridAtMs + IDENTICAL_SETTER_MIN_INTERVAL_MS - Date.now()));
  harness.advanceClock(11 * MINUTE_MS);
  await waitFor(() => latestModel(harness) === "151", 30_000);
  check(
    "the window over: DM151 again, read back as 151",
    latestModel(harness) === "151" && count(receivedSetters(fake.events), "^S006DM151") === 2,
    receivedSetters(fake.events).join(",")
  );
  check(
    "…sent after the restored profile had committed",
    indexOfReceived(fake.events, "^S006DM151", 2) > enforcedBeforeSecond && enforcedBeforeSecond >= 0
  );

  // A full battery, then straight back into the band: 151 waits for the restore
  const enforcedBeforeFull = receivedSetters(fake.events).filter(command => ENFORCED_SETTER.test(command)).length;
  await sleep(Math.max(0, firstOnGridAtMs + IDENTICAL_SETTER_MIN_INTERVAL_MS - Date.now()));
  harness.setSoc(96);
  await waitFor(() => latestModel(harness) === "050", 30_000);
  check(
    "96 %: DM050 so the PV can export",
    latestModel(harness) === "050" && count(receivedSetters(fake.events), "^S006DM050") === 2
  );
  harness.setSoc(50);
  const seenKinds = new Set<AutoGridOffReasonKind>();
  await waitFor(() => {
    const kind = harness.auto.status().reason_kind;
    if (kind) seenKinds.add(kind);
    return latestModel(harness) === "151";
  }, 90_000);
  check(
    "back at 50 %: 151 again once the restore landed",
    latestModel(harness) === "151" && count(receivedSetters(fake.events), "^S006DM151") === 3,
    receivedSetters(fake.events).join(",")
  );
  check("…held back meanwhile by the energy settings", seenKinds.has("energy_settings"), [...seenKinds].join(","));
  check(
    "…and sent only after the enforcement's setters committed",
    receivedSetters(fake.events).filter(command => ENFORCED_SETTER.test(command)).length > enforcedBeforeFull &&
      indexOfReceived(fake.events, "^S006DM151", 3) > lastCommittedEnforcedIndex(fake.events)
  );
  check("no alert raised", harness.raised.length === 0, harness.raised.map(alert => alert.title).join(","));
  harness.dispose();
  await fake.stop();
}

function configWith(
  gridOff: Partial<Config["grid_off"]>,
  schedule: Config["scheduled_power_buying"]["schedule"]
): Config {
  return {
    ...default_config,
    grid_off: { ...default_config.grid_off, ...gridOff },
    scheduled_power_selling: { ...default_config.scheduled_power_selling, schedule: {} },
    scheduled_power_buying: { ...default_config.scheduled_power_buying, schedule },
    // What the switch and the enforcement judge a readback's freshness by (21 min); the engine polls faster
    usb_parameter_setting: { ...default_config.usb_parameter_setting, poll_values_interval_seconds: 600 },
  };
}

function buyWindow(startMs: number, endMs: number): Config["scheduled_power_buying"]["schedule"] {
  return { [new Date(startMs).toISOString()]: { end_time: new Date(endMs).toISOString(), charging_power: 100 } };
}

function startHarness(device: string, initialConfig: Config) {
  const clock = { offsetMs: 0 };
  const harnessNowMs = () => Date.now() + clock.offsetMs;
  const decodedRounds: DecodedRound[] = [];
  const latestFields: { GS?: DecodedRound; PS?: DecodedRound } = {};
  const raised: Parameters<AlertManager["raise"]>[0][] = [];
  const raise: AlertManager["raise"] = async alert => {
    raised.push(alert);
    return { ...alert, at: new Date().toISOString(), delivery: "dry_run" };
  };
  // GS and PS, as the values store holds them, aged on the harness clock
  const mqttValues = {
    get battery_voltage() {
      return readingFrom(latestFields.GS, "battery_voltage", clock.offsetMs);
    },
    get ac_output_total_active_power() {
      return readingFrom(latestFields.PS, "ac_output_total_active_power", clock.offsetMs);
    },
  };
  let built:
    | {
        gridOffSwitch: ReturnType<typeof createGridOffSwitch>;
        enforcement: ReturnType<typeof createEnergyDistributionEnforcement>;
        auto: ReturnType<typeof createAutoGridOff>;
        setSoc: (soc: number) => void;
      }
    | undefined;
  const dispose = createRoot(disposeRoot => {
    const [config] = createSignal<Config>(initialConfig);
    const [soc, setSoc] = createSignal<number | undefined>(50);
    const [lastDecodedRound, setLastDecodedRound] = createSignal<DecodedRound | undefined>(undefined);
    let statusTracker: ReturnType<typeof createInverterStatusTracker> | undefined;
    const engine = createInverterSession({
      devicePath: device,
      poll_values_interval_seconds: () => ENGINE_SETTINGS_POLL_SECONDS,
      onDecodedRound: round => {
        decodedRounds.push(round);
        statusTracker?.trackRound(round);
        if (round.command === "GS" || round.command === "PS") latestFields[round.command] = round;
        // The switch and the enforcement see the round on the harness clock
        setLastDecodedRound({ ...round, decodedAt: round.decodedAt + clock.offsetMs });
      },
      schedulerTimingOverrides: HARNESS_TIMING,
    });
    statusTracker = createInverterStatusTracker(queries => engine.requestStatusQueries(queries));
    const tracker = statusTracker;
    const gridOffSwitch = createGridOffSwitch({
      config,
      queueSetter: engine.queueSetter,
      lastDecodedRound,
      mqttValues,
      soc,
      // The SOC is a plain signal here: its hall sensor input is always fresh
      socSampleAtMs: harnessNowMs,
      raise,
      wallClockNowMs: harnessNowMs,
    });
    const enforcement = createEnergyDistributionEnforcement({
      config,
      queueSetter: engine.queueSetter,
      identicalSetterGateOpensAtMs: engine.identicalSetterGateOpensAtMs,
      requestSettingsReadback: engine.requestSettingsReadback,
      lastDecodedRound,
      workingModeCode: () => tracker.inverterStatus().working_mode?.code,
      requestedMachineModel: gridOffSwitch.requestedMachineModel,
      raise,
      wallClockNowMs: harnessNowMs,
      // The session's gate runs on real time, which the harness clock's jumps don't move
      monotonicNowMs: () => performance.now(),
      timingOverrides: undefined,
    });
    const auto = createAutoGridOff({
      config,
      soc,
      gridOffSwitch,
      energyDistributionStatus: enforcement.status,
      wallClockNowMs: harnessNowMs,
    });
    built = { gridOffSwitch, enforcement, auto, setSoc };
    return disposeRoot;
  });
  if (!built) throw new Error("the harness built nothing");
  const { setSoc, ...parts } = built;
  return {
    ...parts,
    decodedRounds,
    raised,
    /** Time passes for the switch, the enforcement and automatic grid-off; the next SOC reading runs the rules */
    advanceClock: (milliseconds: number) => {
      clock.offsetMs += milliseconds;
      setSoc(50 + Math.random() * 1e-6);
    },
    setSoc: (socPercent: number) => setSoc(socPercent),
    dispose,
  };
}

function readingFrom(
  round: DecodedRound | undefined,
  field: "battery_voltage" | "ac_output_total_active_power",
  offsetMs: number
): { value: number; time: number } | undefined {
  const value = round?.fields[field];
  if (!round || typeof value !== "number") return undefined;
  return { value, time: round.decodedAt + offsetMs };
}

/** The managed fields of the default 050 profile (Load-Battery-Grid, EDA/EDC/EDD/EDE on) */
function profileRestored(hecs: DecodedFields | undefined): boolean {
  return (
    hecs?.solar_energy_distribution_priority === "Load-Battery-Grid" &&
    hecs.solar_charge_battery === "enabled" &&
    hecs.feed_power_to_utility === "enabled" &&
    hecs.battery_discharge_to_loads_when_solar_input_normal === "enabled" &&
    hecs.battery_discharge_to_loads_when_solar_input_loss === "enabled"
  );
}

function latestHecs(harness: { decodedRounds: readonly DecodedRound[] }): DecodedFields | undefined {
  return harness.decodedRounds.findLast(round => round.command === "HECS")?.fields;
}

function latestModel(harness: { decodedRounds: readonly DecodedRound[] }): string | undefined {
  const model = harness.decodedRounds.findLast(round => round.command === "DM")?.fields.machine_model;
  return typeof model === "string" ? model : undefined;
}

function receivedSetters(events: readonly FakeInverterEvent[]): string[] {
  return events.flatMap(event => (event.event === "received" && event.command.startsWith("^S") ? [event.command] : []));
}

function count(commands: readonly string[], command: string): number {
  return commands.filter(candidate => candidate === command).length;
}

/** Index in the fake's event stream of the nth (1-based) arrival of this command; −1 = not (yet) */
function indexOfReceived(events: readonly FakeInverterEvent[], command: string, nth: number): number {
  let seen = 0;
  return events.findIndex(event => event.event === "received" && event.command === command && ++seen === nth);
}

/** Index of the latest commit of an enforced HECS setter (SEP, EDA, EDC, EDD, EDE); −1 = none */
function lastCommittedEnforcedIndex(events: readonly FakeInverterEvent[]): number {
  return events.findLastIndex(event => event.event === "committed" && /^(SEP|ED[ACDE])/.test(event.setter));
}

async function startFakeInverter(fakeArguments: readonly string[]): Promise<{
  device: string;
  /** Live: grows as the fake reports */
  events: readonly FakeInverterEvent[];
  stop: () => Promise<readonly FakeInverterEvent[]>;
}> {
  const child: ChildProcessWithoutNullStreams = spawn("python3", ["-I", FAKE_INVERTER_SCRIPT, ...fakeArguments], {
    stdio: "pipe",
  });
  child.stderr.on("data", (chunk: Buffer) => process.stderr.write(`[fake inverter] ${chunk.toString()}`));
  const events: FakeInverterEvent[] = [];
  const exited = new Promise<void>(resolve => child.on("exit", () => resolve()));
  const device = await new Promise<string>(resolve =>
    readline.createInterface({ input: child.stdout }).on("line", line => {
      // Trusted harness output, one JSON object per line in the shape documented in the .py file
      const event = JSON.parse(line) as FakeInverterEvent;
      events.push(event);
      if (event.event === "ready") resolve(event.device);
    })
  );
  return {
    device,
    events,
    stop: async () => {
      child.stdin.end(); // EOF on its stdin makes it print the summary and exit
      await exited;
      return events;
    },
  };
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) await sleep(20);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}
